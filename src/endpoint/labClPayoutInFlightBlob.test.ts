/**
 * Tests for the in-flight eventKeys blob (B-2d). The eventKeys of an unresolved withdrawNative record are
 * stored once under inflight/<id>/, and the manifest only references them. No chain, no RPC.
 * Timings are printed to stdout (captured in the harness log) for the receipt.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readManifest, readSegmentedState, writeSegmentedState, type SegmentedStateInput } from './labClPayoutStateStore'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`

function withRoot(fn: (root: string) => void): void {
	const base = process.env.LAB_STATE_TEST_ROOT?.trim() || os.tmpdir()
	fs.mkdirSync(base, { recursive: true })
	const root = fs.mkdtempSync(path.join(base, 'lab-inflight-test-'))
	try {
		fn(root)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

function stateWithInFlight(keys: string[], idempotencyKey: string): SegmentedStateInput {
	return {
		lastBackfillProcessedBlock: 7,
		pending: [{ eventKey: hex(999_999) }],
		consumedEventKeys: {},
		exitedPubkeys: {},
		inFlightWithdraw: {
			line: 'history',
			redeem: '0x2222222222222222222222222222222222222222',
			pool: '0x32bE583C8e778FFfC5107BF34820c2B225336201',
			amountWei: '5',
			eventKeys: keys,
			requestFingerprint: `0x${'11'.repeat(32)}`,
			attempt: 0,
			idempotencyKey,
			createdAt: '2026-11-16T00:00:00.000Z',
		},
	}
}

const IDEM = `lab-withdrawNative:${'ab'.repeat(32)}`
const keysOf = (n: number): string[] => Array.from({ length: n }, (_, i) => hex(i + 1))

function blobFiles(dir: string, id: string): Map<string, { ino: number; mtimeMs: number; size: number }> {
	const out = new Map<string, { ino: number; mtimeMs: number; size: number }>()
	const blobDir = path.join(dir, 'inflight', id)
	for (const name of fs.readdirSync(blobDir)) {
		const st = fs.statSync(path.join(blobDir, name))
		out.set(name, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size })
	}
	return out
}

test('B-2d: the in-flight keys are written once as a separate blob; the next commit references it without rewriting it', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		const keys = keysOf(50_000)
		const st = stateWithInFlight(keys, IDEM)
		const t1 = process.hrtime.bigint()
		writeSegmentedState(dir, st, { segmentSize: 10_000 })
		const writeMs = Number(process.hrtime.bigint() - t1) / 1e6
		const m1 = readManifest(dir)
		assert.ok(m1.inFlightKeys, 'the manifest references the blob')
		assert.equal(m1.inFlightKeys!.count, 50_000)
		assert.equal(m1.inFlightKeys!.segments.length, 5)
		assert.equal(Object.prototype.hasOwnProperty.call(m1.scalars.inFlightWithdraw as object, 'eventKeys'), false, 'eventKeys are not in the manifest scalars')
		const before = blobFiles(dir, m1.inFlightKeys!.id)

		const t2 = process.hrtime.bigint()
		writeSegmentedState(dir, st, { segmentSize: 10_000 })
		const secondMs = Number(process.hrtime.bigint() - t2) / 1e6
		const m2 = readManifest(dir)
		assert.equal(m2.inFlightKeys!.id, m1.inFlightKeys!.id)
		const after = blobFiles(dir, m2.inFlightKeys!.id)
		assert.deepEqual([...after.entries()], [...before.entries()], 'same inode, mtime and size: not rewritten')
		assert.ok(fs.statSync(path.join(dir, 'manifest.json')).size < 20_000, 'the manifest stays small')
		assert.deepEqual(readSegmentedState(dir).inFlightWithdraw, { ...(st.inFlightWithdraw as Record<string, unknown>), eventKeys: keys })
		console.log(`B-2d timing keys=50000 segments=5 firstCommitMs=${writeMs.toFixed(1)} secondCommitMs=${secondMs.toFixed(1)} manifestBytes=${fs.statSync(path.join(dir, 'manifest.json')).size}`)
	})
})

test('B-2d: a new process re-derives the same blob id and verifies it without rewriting it', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(2_000), IDEM), { segmentSize: 500 })
		const id = readManifest(dir).inFlightKeys!.id
		const before = blobFiles(dir, id)
		const loaded = readSegmentedState(dir) // a fresh array object, as after a restart
		writeSegmentedState(dir, { ...loaded, pending: [{ eventKey: hex(42) }] }, { segmentSize: 500 })
		assert.equal(readManifest(dir).inFlightKeys!.id, id)
		assert.deepEqual([...blobFiles(dir, id).entries()], [...before.entries()])
	})
})

test('B-2d: a tampered key file fails closed on read', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(1_000), IDEM), { segmentSize: 400 })
		const id = readManifest(dir).inFlightKeys!.id
		const file = path.join(dir, 'inflight', id, 'key-000001.jsonl')
		const text = fs.readFileSync(file, 'utf8')
		fs.writeFileSync(file, text.replace(/0x0/, '0x1'))
		assert.throws(() => readSegmentedState(dir), /sha256|count|hash/)
	})
})

test('B-2d: a missing blob directory fails closed on read; nothing is returned as empty', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(300), IDEM), { segmentSize: 100 })
		const id = readManifest(dir).inFlightKeys!.id
		fs.rmSync(path.join(dir, 'inflight', id), { recursive: true, force: true })
		assert.throws(() => readSegmentedState(dir), /in-flight blob directory missing/)
	})
})

test('B-2d: once the record is resolved, the next commit removes its blob and no in-flight field remains', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(300), IDEM), { segmentSize: 100 })
		const id = readManifest(dir).inFlightKeys!.id
		const { inFlightWithdraw: _dropped, ...rest } = stateWithInFlight([], IDEM)
		void _dropped
		writeSegmentedState(dir, rest, { segmentSize: 100 })
		assert.equal(fs.existsSync(path.join(dir, 'inflight', id)), false, 'the unreferenced blob is removed after the commit')
		assert.equal(readManifest(dir).inFlightKeys, undefined)
		assert.equal(readSegmentedState(dir).inFlightWithdraw, undefined)
	})
})

test('F4: a key file whose bytes change but whose keys do not fails the digest check (keys still match)', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(1_000), IDEM), { segmentSize: 400 })
		const id = readManifest(dir).inFlightKeys!.id
		const file = path.join(dir, 'inflight', id, 'key-000001.jsonl')
		// A trailing space is valid JSON whitespace: the parsed keys are unchanged, the bytes are not.
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/, ' \n'))
		assert.throws(() => readSegmentedState(dir), /byte count|sha256 does not match/)
	})
})

test('F4: a blob directory whose id does not match its record fails closed, even with consistent digests', () => {
	withRoot((root) => {
		const dir = path.join(root, 'ledger.v2')
		writeSegmentedState(dir, stateWithInFlight(keysOf(300), IDEM), { segmentSize: 100 })
		const manifestFile = path.join(dir, 'manifest.json')
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { inFlightKeys: { id: string } }
		const oldId = manifest.inFlightKeys.id
		const fakeId = 'f'.repeat(64)
		fs.renameSync(path.join(dir, 'inflight', oldId), path.join(dir, 'inflight', fakeId))
		manifest.inFlightKeys.id = fakeId
		fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
		assert.throws(() => readSegmentedState(dir), /in-flight blob id does not match its record/)
	})
})
