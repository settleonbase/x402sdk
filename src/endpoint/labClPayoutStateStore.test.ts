/**
 * Unit tests for labClPayoutStateStore (format v2) and its migration path.
 * No chain, no RPC, no signer, no network. Temp dirs go under LAB_STATE_TEST_ROOT when set,
 * otherwise under os.tmpdir().
 * Compile with tsconfig.test.json (tests are excluded from the main build) and run with node --test.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertNoRemigration, nextHistoryWindow, pruneOrder } from './labMiningPoolDualCursor'
import { parseArgs, runMigration } from './labClPayoutStateMigrate'
import {
	canonicalJson,
	SEGMENTED_COMMIT_FENCE_FILE,
	SegmentedCommitDurabilityUnknownError,
	dryRunLegacyMigration,
	inspectSegmentedDir,
	keySetHash,
	legacyBackupPathFor,
	legacyStateFileExists,
	loadLegacyStateFile,
	migrateLegacyToSegmented,
	pathExistsStrict,
	readGenerationFromManifest,
	readManifest,
	readSegmentedState,
	segmentedDirForLegacy,
	sha256File,
	summarizeState,
	writeGeneration,
	writeSegmentedState,
	type PendingRecord,
	type SegmentedState,
} from './labClPayoutStateStore'

function sha(text: string): string {
	return createHash('sha256').update(text).digest('hex')
}

function hexKey(tag: string, i: number): string {
	return `0x${sha(`${tag}:${i}`)}`
}

function makeState(counts: { pending: number; consumed: number; exited: number }): SegmentedState {
	const pending: PendingRecord[] = []
	for (let i = 0; i < counts.pending; i++) {
		pending.push({
			eventKey: hexKey('pending', i),
			amount: '796176000000000',
			blockNumber: 2009200 + i,
			withdrawalIndex: 32083806 + i,
			pubkey: `0x${sha(`pk:${i % 3}`)}${'0'.repeat(32)}`,
		})
	}
	const consumedEventKeys: Record<string, true> = {}
	for (let i = 0; i < counts.consumed; i++) consumedEventKeys[hexKey('consumed', i)] = true
	const exitedPubkeys: Record<string, true> = {}
	for (let i = 0; i < counts.exited; i++) exitedPubkeys[`0x${sha(`exited:${i}`)}`] = true
	return {
		lastBackfillProcessedBlock: 2136205,
		lastListeningEndBlock: 2135886,
		lastLiveHeadScanned: 2167474,
		freezeH: { height: 2167000, hash: `0x${'cd'.repeat(32)}`, frozenAt: '2026-11-16T00:00:00.000Z' },
		historyCursor: 2100000,
		realtimeCursor: 2166999,
		pending,
		gasWaitStartedAt: '2026-11-16T01:00:00.000Z',
		consumedEventKeys,
		exitedPubkeys,
		updatedAt: '2026-11-16T02:00:00.000Z',
	}
}

function tempRoot(): string {
	const base = process.env.LAB_STATE_TEST_ROOT?.trim() || os.tmpdir()
	fs.mkdirSync(base, { recursive: true })
	return fs.mkdtempSync(path.join(base, 'lab-state-test-'))
}

function withRoot(fn: (root: string) => void): void {
	const root = tempRoot()
	try {
		fn(root)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

function listGenerationDirs(dir: string): string[] {
	return fs.readdirSync(dir).filter((n) => /^gen-/.test(n))
}

function intersectionSize(a: string[], b: string[]): number {
	const set = new Set(a.map((x) => x.toLowerCase()))
	return b.filter((x) => set.has(x.toLowerCase())).length
}

test('keySetHash is order independent and matches the documented form', () => {
	assert.equal(keySetHash(['0x02', '0x01']), keySetHash(['0x01', '0x02']))
	assert.equal(keySetHash(['0x02', '0x01']), sha('0x01\n0x02\n'))
	assert.equal(keySetHash([]), sha(''))
	assert.notEqual(keySetHash(['0x01']), keySetHash(['0x01', '0x01']), 'multiset: duplicates count')
})

test('canonicalJson sorts keys recursively', () => {
	assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}')
})

test('small round trip: 5 pending, 10 consumed, 2 exited, segment size 2', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const st = makeState({ pending: 5, consumed: 10, exited: 2 })
		const first = writeSegmentedState(dir, st, { segmentSize: 2 })
		assert.equal(first.previousGeneration, null)
		assert.equal(inspectSegmentedDir(dir), 'committed')

		const manifest = readManifest(dir)
		assert.deepEqual(
			manifest.pending.segments.map((s) => s.lines),
			[2, 2, 1],
			'5 entries at segment size 2 give 2+2+1'
		)
		assert.deepEqual(
			manifest.pending.segments.map((s) => s.file),
			['pending-000000.jsonl', 'pending-000001.jsonl', 'pending-000002.jsonl']
		)

		const back = readSegmentedState(dir)
		assert.deepStrictEqual(back, st, 'every field round-trips, including freezeH, cursors, updatedAt')
		assert.deepEqual(Object.keys(back.consumedEventKeys), Object.keys(st.consumedEventKeys), 'consumed order kept')

		assert.equal(keySetHash(back.pending.map((e) => e.eventKey)), manifest.pending.keySetSha256)
		assert.equal(keySetHash(Object.keys(back.consumedEventKeys)), manifest.consumed.keySetSha256)
		assert.equal(keySetHash(Object.keys(back.exitedPubkeys)), manifest.exited.keySetSha256)
		assert.equal(manifest.pending.count, 5)
		assert.equal(manifest.consumed.lines, 10)
		assert.equal(manifest.exited.lines, 2)
	})
})

test('a second commit keeps the previous generation and prunes older ones', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const a = writeSegmentedState(dir, makeState({ pending: 3, consumed: 1, exited: 0 }), { segmentSize: 2 })
		const b = writeSegmentedState(dir, makeState({ pending: 4, consumed: 2, exited: 1 }), { segmentSize: 2 })
		assert.equal(b.previousGeneration, a.generation)
		assert.deepEqual(listGenerationDirs(dir).sort(), [a.generation, b.generation].sort())
		const c = writeSegmentedState(dir, makeState({ pending: 1, consumed: 0, exited: 0 }), { segmentSize: 2 })
		assert.equal(c.previousGeneration, b.generation)
		assert.deepEqual(listGenerationDirs(dir).sort(), [b.generation, c.generation].sort(), 'generation before previous is removed')
		assert.equal(readSegmentedState(dir).pending.length, 1)
	})
})

test('fail closed: a changed byte in a segment throws', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const r = writeSegmentedState(dir, makeState({ pending: 5, consumed: 3, exited: 1 }), { segmentSize: 2 })
		const seg = path.join(dir, r.generation, 'pending-000001.jsonl')
		const text = fs.readFileSync(seg, 'utf8')
		const flipped = text.replace('"amount":"796176000000000"', '"amount":"896176000000000"')
		assert.equal(flipped.length, text.length)
		assert.notEqual(flipped, text)
		fs.writeFileSync(seg, flipped)
		assert.throws(() => readSegmentedState(dir), /sha256 does not match|key-set|pending/)
	})
})

test('fail closed: a truncated consumed file throws', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const r = writeSegmentedState(dir, makeState({ pending: 2, consumed: 4, exited: 0 }), { segmentSize: 2 })
		const file = path.join(dir, r.generation, 'consumed.jsonl')
		const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0)
		fs.writeFileSync(file, `${lines.slice(0, -1).join('\n')}\n`)
		assert.throws(() => readSegmentedState(dir), /line count|byte count|sha256/)
	})
})

test('fail closed: missing manifest with segment files present never returns an empty state', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		writeSegmentedState(dir, makeState({ pending: 5, consumed: 3, exited: 1 }), { segmentSize: 2 })
		const manifestPath = path.join(dir, 'manifest.json')
		const saved = fs.readFileSync(manifestPath, 'utf8')
		fs.rmSync(manifestPath)
		assert.equal(inspectSegmentedDir(dir), 'orphan')
		assert.throws(() => readSegmentedState(dir), /no committed manifest/)
		fs.writeFileSync(manifestPath, saved)
		assert.equal(readSegmentedState(dir).pending.length, 5, 'restoring the manifest restores the state')
	})
})

test('fail closed: tampered scalars, missing segment, missing dir, and a bad manifest all throw', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		assert.throws(() => readSegmentedState(dir), /no committed manifest/)
		assert.equal(inspectSegmentedDir(dir), 'absent')

		const r = writeSegmentedState(dir, makeState({ pending: 4, consumed: 2, exited: 1 }), { segmentSize: 2 })
		const manifestPath = path.join(dir, 'manifest.json')
		const original = fs.readFileSync(manifestPath, 'utf8')

		const tampered = JSON.parse(original)
		tampered.scalars.lastBackfillProcessedBlock = 1
		fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2))
		assert.throws(() => readSegmentedState(dir), /scalars sha256/)

		fs.writeFileSync(manifestPath, '{not json')
		assert.throws(() => readSegmentedState(dir), /not valid JSON/)

		fs.writeFileSync(manifestPath, original)
		fs.rmSync(path.join(dir, r.generation, 'pending-000001.jsonl'))
		assert.throws(() => readSegmentedState(dir), /ENOENT|no such file/i)
	})
})

test('crash: a prepared but uncommitted generation is ignored and the last commit still reads', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const stateA = makeState({ pending: 5, consumed: 6, exited: 2 })
		const a = writeSegmentedState(dir, stateA, { segmentSize: 2 })

		const stateB = makeState({ pending: 7, consumed: 9, exited: 2 })
		stateB.lastBackfillProcessedBlock = 2136999
		const prepared = writeGeneration(dir, stateB, { segmentSize: 2 })
		assert.notEqual(prepared.generation, a.generation)
		assert.deepEqual(readSegmentedState(dir), stateA, 'uncommitted generation is invisible')
		assert.equal(readManifest(dir).generation, a.generation)
		assert.equal(inspectSegmentedDir(dir), 'committed')
		assert.throws(() => readGenerationFromManifest(dir, { ...prepared.manifest, generation: a.generation }))
	})
})

test('crash before the manifest rename: previous state readable, new generation removed', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const stateA = makeState({ pending: 5, consumed: 6, exited: 2 })
		const a = writeSegmentedState(dir, stateA, { segmentSize: 2 })
		const stateB = makeState({ pending: 8, consumed: 9, exited: 3 })
		assert.throws(
			() =>
				writeSegmentedState(dir, stateB, {
					segmentSize: 2,
					hooks: {
						beforeCommit: () => {
							throw new Error('simulated crash before commit')
						},
					},
				}),
			/simulated crash before commit/
		)
		assert.deepEqual(readSegmentedState(dir), stateA)
		assert.equal(readManifest(dir).generation, a.generation)
		assert.deepEqual(listGenerationDirs(dir), [a.generation], 'failed generation directory is removed')
	})
})

test('crash mid-write (after a data file): previous state readable and the next good write cleans up', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const stateA = makeState({ pending: 3, consumed: 2, exited: 1 })
		writeSegmentedState(dir, stateA, { segmentSize: 2 })

		const stateB = makeState({ pending: 6, consumed: 4, exited: 1 })
		assert.throws(
			() =>
				writeSegmentedState(dir, stateB, {
					segmentSize: 2,
					hooks: {
						afterFile: (rel) => {
							if (rel.endsWith('pending-000001.jsonl')) throw new Error('simulated crash mid-write')
						},
					},
				}),
			/simulated crash mid-write/
		)
		assert.deepEqual(readSegmentedState(dir), stateA)
		assert.equal(listGenerationDirs(dir).length, 1)

		// Orphan left by a process death (no cleanup run): unreferenced, ignored, then pruned on next commit.
		const orphan = writeGeneration(dir, stateB, { segmentSize: 2 })
		assert.ok(fs.existsSync(orphan.genDir))
		assert.deepEqual(readSegmentedState(dir), stateA)
		const next = writeSegmentedState(dir, makeState({ pending: 2, consumed: 0, exited: 0 }), { segmentSize: 2 })
		assert.equal(fs.existsSync(orphan.genDir), false, 'orphan generation pruned on next commit')
		assert.deepEqual(listGenerationDirs(dir).sort(), [next.generation, next.previousGeneration].filter(Boolean).sort())
	})
})

test('invariant: pending and consumed are disjoint after round trip, and overlap is detected', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const st = makeState({ pending: 6, consumed: 8, exited: 0 })
		writeSegmentedState(dir, st, { segmentSize: 3 })
		const back = readSegmentedState(dir)
		const pendingKeys = back.pending.map((e) => e.eventKey)
		assert.equal(intersectionSize(pendingKeys, Object.keys(back.consumedEventKeys)), 0)

		const bad = makeState({ pending: 2, consumed: 1, exited: 0 })
		bad.consumedEventKeys[bad.pending[0].eventKey] = true
		assert.equal(summarizeState(bad).pendingConsumedOverlap, 1)
	})
})

test('writer refuses bad input', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		assert.throws(() => writeSegmentedState(dir, { pending: [{ amount: '1' } as never] }), /eventKey/)
		assert.throws(() => writeSegmentedState(dir, { consumedEventKeys: { '0x01': false as never } }), /true/)
		const protoMap = JSON.parse('{"__proto__": true}') as Record<string, true>
		assert.throws(() => writeSegmentedState(dir, { exitedPubkeys: protoMap }), /invalid key/)
		assert.throws(() => writeSegmentedState(dir, makeState({ pending: 1, consumed: 0, exited: 0 }), { segmentSize: 0 }), /segmentSize/)
		assert.equal(inspectSegmentedDir(dir), 'absent', 'nothing is written on refusal')
	})
})

test('migration: legacy pretty and compact files migrate with identical counts and hashes', () => {
	withRoot((root) => {
		const legacyObj = makeState({ pending: 5, consumed: 10, exited: 2 })
		const variants: Array<[string, string]> = [
			['pretty', `${JSON.stringify(legacyObj, null, 2)}\n`],
			['compact', `${JSON.stringify(legacyObj)}\n`],
		]
		const summaries: string[] = []
		for (const [label, text] of variants) {
			const legacy = path.join(root, `legacy-${label}.json`)
			fs.writeFileSync(legacy, text)
			const sha0 = sha256File(legacy)
			const targetDir = segmentedDirForLegacy(legacy)
			assert.equal(targetDir, path.join(root, `legacy-${label}.v2`))

			const dry = dryRunLegacyMigration(legacy, targetDir)
			assert.equal(dry.refuseReason, null)
			assert.equal(dry.targetStatus, 'absent')
			assert.equal(fs.existsSync(targetDir), false, 'dry-run writes nothing')
			assert.equal(fs.existsSync(legacyBackupPathFor(legacy, sha0)), false, 'dry-run makes no backup')

			const result = migrateLegacyToSegmented(legacy, targetDir, { segmentSize: 2 })
			assert.equal(result.verified, true)
			assert.deepEqual(result.summary, dry.summary, 'apply summary equals dry-run summary')
			assert.equal(sha256File(legacy), sha0, 'legacy file bytes unchanged')
			assert.equal(result.legacySha256, sha0)

			const backup = legacyBackupPathFor(legacy, sha0)
			assert.equal(path.basename(backup), `legacy-${label}.json.legacy-${sha0.slice(0, 16)}.json`)
			assert.equal(sha256File(backup), sha0, 'backup copy matches the original')

			const back = readSegmentedState(targetDir)
			assert.deepStrictEqual(back, legacyObj, 'migrated state equals legacy content')
			assert.equal(summarizeState(back).pendingCount, 5)
			assert.equal(summarizeState(back).consumedCount, 10)
			assert.equal(summarizeState(back).exitedCount, 2)
			summaries.push(JSON.stringify(result.summary))

			assert.throws(() => migrateLegacyToSegmented(legacy, targetDir), /already has a committed manifest/)
		}
		assert.equal(summaries[0], summaries[1], 'pretty and compact legacy produce the same v2 summary')
	})
})

test('migration: explicitly start the first history window without replacing legacy cursors or paid keys', () => {
	withRoot((root) => {
		const legacy = path.join(root, 'legacy.json')
		const old = makeState({ pending: 5, consumed: 10, exited: 2 })
		delete old.historyCursor
		delete old.realtimeCursor
		delete old.freezeH
		fs.writeFileSync(legacy, JSON.stringify(old))
		const sha = sha256File(legacy)
		const args = ['--state-file', legacy, '--initial-history-block', '2009200']
		const preview = runMigration(parseArgs(args)) as { summary: unknown; written: boolean }
		assert.equal(preview.written, false)
		const dir = segmentedDirForLegacy(legacy)
		assert.equal(fs.existsSync(dir), false)
		const applied = runMigration(parseArgs([...args, '--apply'])) as { summary: unknown; written: boolean }
		assert.equal(applied.written, true)
		assert.deepEqual(applied.summary, preview.summary)
		const first = readSegmentedState(dir)
		assert.deepEqual(first, { ...old, historyCursor: 2_009_199 })
		assert.deepEqual(nextHistoryWindow(Number(first.historyCursor), 2_234_779, 32),
			{ line: 'history', from: 2_009_200, to: 2_009_231 })
		writeSegmentedState(dir, { ...first, historyCursor: 2_009_231, realtimeCursor: 2_234_781 })
		const reopened = readSegmentedState(dir)
		assert.equal(reopened.historyCursor, 2_009_231)
		assert.equal(reopened.realtimeCursor, 2_234_781)
		assert.deepEqual(reopened.consumedEventKeys, old.consumedEventKeys)
		assert.throws(() => runMigration(parseArgs([...args, '--apply'])), /already has a committed manifest/)
		assert.equal(sha256File(legacy), sha)
	})
})

test('migration: an explicit first history block cannot overwrite initialized dual cursors', () => {
	withRoot((root) => {
		const legacy = path.join(root, 'legacy.json')
		fs.writeFileSync(legacy, JSON.stringify({ ...makeState({ pending: 1, consumed: 1, exited: 0 }), realtimeCursor: 2_200_000 }))
		const dir = segmentedDirForLegacy(legacy)
		assert.throws(() => dryRunLegacyMigration(legacy, dir, 2_009_200), /refusing to replace initialized dual cursors/)
		assert.throws(() => migrateLegacyToSegmented(legacy, dir, { initialHistoryBlock: 2_009_200 }),
			/refusing to replace initialized dual cursors/)
		assert.equal(fs.existsSync(dir), false)
		assert.throws(() => parseArgs(['--initial-history-block', '0']), /positive safe integer/)
	})
})

test('migration: a legacy file with missing collections defaults them and reports it', () => {
	withRoot((root) => {
		const legacyObj: Record<string, unknown> = { ...makeState({ pending: 2, consumed: 3, exited: 0 }) }
		delete legacyObj.exitedPubkeys
		const legacy = path.join(root, 'legacy.json')
		fs.writeFileSync(legacy, JSON.stringify(legacyObj))
		const loaded = loadLegacyStateFile(legacy)
		assert.deepEqual(loaded.defaulted, ['exitedPubkeys'])
		const result = migrateLegacyToSegmented(legacy, segmentedDirForLegacy(legacy), { segmentSize: 2 })
		assert.equal(result.summary.exitedCount, 0)
	})
})

test('migration refuses when pending overlaps consumed, and writes nothing', () => {
	withRoot((root) => {
		const legacyObj = makeState({ pending: 3, consumed: 2, exited: 0 })
		legacyObj.consumedEventKeys[legacyObj.pending[1].eventKey] = true
		const legacy = path.join(root, 'legacy.json')
		const text = JSON.stringify(legacyObj)
		fs.writeFileSync(legacy, text)
		const sha0 = sha256File(legacy)
		const targetDir = segmentedDirForLegacy(legacy)
		assert.match(dryRunLegacyMigration(legacy, targetDir).refuseReason ?? '', /consumedEventKeys/)
		assert.throws(() => migrateLegacyToSegmented(legacy, targetDir, { segmentSize: 2 }), /also in consumedEventKeys/)
		assert.equal(fs.existsSync(targetDir), false)
		assert.equal(fs.existsSync(legacyBackupPathFor(legacy, sha0)), false)
		assert.equal(sha256File(legacy), sha0)
	})
})

test('migration reuses an identical backup on retry and refuses a different one', () => {
	withRoot((root) => {
		const legacy = path.join(root, 'legacy.json')
		fs.writeFileSync(legacy, JSON.stringify(makeState({ pending: 2, consumed: 1, exited: 0 })))
		const sha0 = sha256File(legacy)
		const backup = legacyBackupPathFor(legacy, sha0)

		// Retry after an earlier attempt that already made the backup: reuse it.
		fs.copyFileSync(legacy, backup)
		const ok = migrateLegacyToSegmented(legacy, path.join(root, 'retry.v2'), { segmentSize: 2 })
		assert.equal(ok.legacyBackupPath, backup)
		assert.equal(sha256File(backup), sha0)

		// A backup name collision with different bytes must stop the migration.
		fs.writeFileSync(backup, 'different bytes')
		assert.throws(
			() => migrateLegacyToSegmented(legacy, path.join(root, 'other.v2'), { segmentSize: 2 }),
			/backup exists with different content/
		)
		assert.equal(fs.existsSync(path.join(root, 'other.v2')), false, 'nothing written when the backup check fails')
	})
})

test('migration rejects legacy values other than true', () => {
	withRoot((root) => {
		const legacyObj = makeState({ pending: 1, consumed: 2, exited: 0 })
		const key = Object.keys(legacyObj.consumedEventKeys)[0]
		;(legacyObj.consumedEventKeys as Record<string, unknown>)[key] = false
		const legacy = path.join(root, 'legacy.json')
		fs.writeFileSync(legacy, JSON.stringify(legacyObj))
		assert.throws(() => loadLegacyStateFile(legacy), /true/)
		assert.equal(fs.existsSync(segmentedDirForLegacy(legacy)), false)
	})
})

test('migration of an empty legacy state round-trips', () => {
	withRoot((root) => {
		const legacyObj = makeState({ pending: 0, consumed: 0, exited: 0 })
		const legacy = path.join(root, 'legacy.json')
		fs.writeFileSync(legacy, JSON.stringify(legacyObj, null, 2))
		const result = migrateLegacyToSegmented(legacy, segmentedDirForLegacy(legacy))
		assert.equal(result.summary.pendingCount, 0)
		assert.deepStrictEqual(readSegmentedState(segmentedDirForLegacy(legacy)), legacyObj)
		assert.equal(keySetHash([]), result.summary.pendingKeySetSha256)
	})
})

function errCode(e: unknown): string | undefined {
	return (e as NodeJS.ErrnoException | undefined)?.code
}

const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('C1: only ENOENT means absent; a permission error on the parent dir throws (never empty state)', { skip: runningAsRoot ? 'root ignores mode bits' : false }, () => {
	withRoot((root) => {
		const parent = path.join(root, 'locked')
		fs.mkdirSync(parent, { mode: 0o700 })
		const dir = path.join(parent, 'state.v2')
		writeSegmentedState(dir, makeState({ pending: 2, consumed: 1, exited: 0 }), { segmentSize: 2 })
		const legacy = path.join(parent, 'state.json')
		fs.writeFileSync(legacy, '{}')
		fs.chmodSync(parent, 0o000)
		try {
			assert.throws(() => inspectSegmentedDir(dir), (e: unknown) => errCode(e) === 'EACCES', 'inspectSegmentedDir must not report absent')
			assert.throws(() => legacyStateFileExists(legacy), (e: unknown) => errCode(e) === 'EACCES', 'legacy check must not report absent')
			assert.throws(() => pathExistsStrict(path.join(dir, 'manifest.json')), (e: unknown) => errCode(e) === 'EACCES')
		} finally {
			fs.chmodSync(parent, 0o700)
		}
		assert.equal(inspectSegmentedDir(dir), 'committed', 'after the permission is restored the state is seen again')
		assert.equal(readSegmentedState(dir).pending.length, 2)
	})
})

test('C1: ENOENT is still absent, for a missing dir, a missing legacy file, and a missing manifest', () => {
	withRoot((root) => {
		assert.equal(inspectSegmentedDir(path.join(root, 'none.v2')), 'absent')
		assert.equal(legacyStateFileExists(path.join(root, 'none.json')), false)
		assert.equal(pathExistsStrict(path.join(root, 'none')), false)
		const dir = path.join(root, 'empty.v2')
		fs.mkdirSync(dir)
		assert.equal(inspectSegmentedDir(dir), 'absent', 'an empty dir is absent, not orphan')
	})
})

test('C2 (M1): a manifest whose key-set hash does not match its key files is rejected for pending, consumed and exited', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		writeSegmentedState(dir, makeState({ pending: 5, consumed: 10, exited: 2 }), { segmentSize: 2 })
		const manifestPath = path.join(dir, 'manifest.json')
		const original = fs.readFileSync(manifestPath, 'utf8')
		const cases: Array<[string, (m: any) => void, RegExp]> = [
			['pending', (m) => { m.pending.keySetSha256 = '0'.repeat(64) }, /pending key-set hash does not match manifest/],
			['consumed', (m) => { m.consumed.keySetSha256 = 'f'.repeat(64) }, /consumed\.jsonl: key-set hash does not match manifest/],
			['exited', (m) => { m.exited.keySetSha256 = 'f'.repeat(64) }, /exited\.jsonl: key-set hash does not match manifest/],
		]
		for (const [label, tamper, expect] of cases) {
			const m = JSON.parse(original)
			tamper(m)
			fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))
			assert.throws(() => readSegmentedState(dir), expect, `${label} key-set tamper must throw`)
			fs.writeFileSync(manifestPath, original)
		}
		assert.equal(readSegmentedState(dir).pending.length, 5, 'restored manifest reads again')
	})
})

test('C2 (M2): commit is atomic. A failure after staging leaves the previous manifest visible and intact', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const stateA = makeState({ pending: 5, consumed: 6, exited: 2 })
		const a = writeSegmentedState(dir, stateA, { segmentSize: 2 })
		const manifestPath = path.join(dir, 'manifest.json')
		const before = fs.readFileSync(manifestPath, 'utf8')
		let visibleWhileStaged: string | null = null
		let stagedName = ''
		assert.throws(
			() =>
				writeSegmentedState(dir, makeState({ pending: 8, consumed: 9, exited: 3 }), {
					segmentSize: 2,
					hooks: {
						beforeManifestRename: (staged) => {
							visibleWhileStaged = fs.readFileSync(manifestPath, 'utf8')
							stagedName = path.basename(staged)
							throw new Error('simulated crash at the commit point')
						},
					},
				}),
			/simulated crash at the commit point/
		)
		assert.equal(visibleWhileStaged, before, 'the visible manifest is unchanged while the new one is only staged')
		assert.notEqual(stagedName, 'manifest.json', 'the new manifest is staged under a tmp name')
		assert.equal(fs.readFileSync(manifestPath, 'utf8'), before, 'manifest intact after the failed commit')
		assert.equal(readManifest(dir).generation, a.generation)
		assert.deepEqual(readSegmentedState(dir), stateA)
		assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('manifest.json.tmp.')), [], 'staged file removed')
	})
})

/** Spy on fsync of directory descriptors (records inode, optionally fails). Restores fs.fsyncSync. */
function withDirFsyncSpy(opts: { failDirs: boolean }, fn: (dirInodes: number[]) => void): void {
	const real = fs.fsyncSync
	const dirInodes: number[] = []
	;(fs as any).fsyncSync = (fd: number) => {
		const st = fs.fstatSync(fd)
		if (st.isDirectory()) {
			dirInodes.push(st.ino)
			if (opts.failDirs) throw Object.assign(new Error('simulated EIO on directory fsync'), { code: 'EIO' })
		}
		return real(fd)
	}
	try {
		fn(dirInodes)
	} finally {
		;(fs as any).fsyncSync = real
	}
}

test('post-rename directory fsync failure persists a cross-process fence and preserves both generations', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const keyA = hexKey('in-flight-a', 1)
		const keyB = hexKey('in-flight-b', 1)
		const stateA = {
			...makeState({ pending: 3, consumed: 4, exited: 1 }),
			labPayoutSendAttempts: 7,
			labPayoutSendAttemptLimit: 10,
			inFlightWithdraw: { eventKeys: [keyA], idempotencyKey: 'intent-a', status: 'unknown', attempt: 1 },
		}
		const stateB = {
			...makeState({ pending: 4, consumed: 5, exited: 1 }),
			labPayoutSendAttempts: 8,
			labPayoutSendAttemptLimit: 10,
			inFlightWithdraw: { eventKeys: [keyB], idempotencyKey: 'intent-b', status: 'unknown', attempt: 2 },
		}
		const old = writeSegmentedState(dir, stateA, { segmentSize: 2, retainInFlightBlobs: true })
		const oldManifest = readManifest(dir)
		const parentIno = fs.statSync(dir).ino
		const realFsync = fs.fsyncSync
		let parentSyncs = 0
		let injected = false
		;(fs as any).fsyncSync = (fd: number) => {
			const st = fs.fstatSync(fd)
			if (st.isDirectory() && st.ino === parentIno) {
				parentSyncs++
				// 1: pre-commit parent sync; 2: durable fence; 3: post-rename sync.
				if (parentSyncs === 3) {
					injected = true
					throw Object.assign(new Error('simulated EIO after manifest rename'), { code: 'EIO' })
				}
			}
			return realFsync(fd)
		}
		try {
			assert.throws(
				() => writeSegmentedState(dir, stateB, { segmentSize: 2, retainInFlightBlobs: true }),
				(e: unknown) => e instanceof SegmentedCommitDurabilityUnknownError &&
					(e as SegmentedCommitDurabilityUnknownError).code === 'LAB_STATE_COMMIT_DURABILITY_UNKNOWN'
			)
		} finally {
			;(fs as any).fsyncSync = realFsync
		}
		assert.equal(injected, true, 'failure was injected at the post-rename parent fsync')
		const visible = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
		assert.equal(visible.previousGeneration, old.generation)
		assert.notEqual(visible.generation, old.generation, 'new manifest is visible')
		const fence = JSON.parse(fs.readFileSync(path.join(dir, SEGMENTED_COMMIT_FENCE_FILE), 'utf8'))
		assert.equal(fence.previousGeneration, old.generation)
		assert.equal(fence.candidateGeneration, visible.generation)
		assert.equal(fence.previousInFlightId, oldManifest.inFlightKeys?.id)
		assert.equal(fence.candidateInFlightId, visible.inFlightKeys?.id)
		assert.ok(listGenerationDirs(dir).includes(old.generation), 'previous generation is preserved')
		assert.ok(listGenerationDirs(dir).includes(visible.generation), 'candidate generation is preserved')
		assert.ok(fs.existsSync(path.join(dir, 'inflight', fence.previousInFlightId)), 'previous in-flight blob is preserved')
		assert.ok(fs.existsSync(path.join(dir, 'inflight', fence.candidateInFlightId)), 'candidate in-flight blob is preserved')
		assert.throws(() => readSegmentedState(dir), /commit durability unknown/)
		assert.throws(() => readManifest(dir), /commit durability unknown/)
		assert.throws(() => readGenerationFromManifest(dir, visible), /commit durability unknown/)
		assert.throws(() => writeSegmentedState(dir, stateB, { segmentSize: 2 }), /commit durability unknown/)
		const storeJs = path.join(__dirname, 'labClPayoutStateStore.js')
		const storeModule = fs.existsSync(storeJs) ? storeJs : path.join(__dirname, 'labClPayoutStateStore.ts')
		const childArgs: string[] = []
		const tsHook = process.env.LAB_STATE_TEST_TS_HOOK
		if (tsHook) childArgs.push('--require', tsHook)
		childArgs.push('-e',
			"const s=require(process.argv[1]);try{s.readSegmentedState(process.argv[2]);process.exit(0)}catch(e){process.stderr.write(String(e.code||e.name));process.exit(31)}",
			storeModule, dir)
		const child = spawnSync(process.execPath, childArgs, { encoding: 'utf8', timeout: 5_000 })
		assert.equal(child.status, 31, 'fresh process must refuse the fence')
		assert.equal(child.stderr, 'LAB_STATE_COMMIT_DURABILITY_UNKNOWN')
		assert.equal(fs.existsSync(path.join(dir, SEGMENTED_COMMIT_FENCE_FILE)), true, 'no automatic fence cleanup')
	})
})

test('C3: genDir and its parent dir are fsynced before the manifest is staged', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		withDirFsyncSpy({ failDirs: false }, (inodes) => {
			let beforeCommitInodes: number[] = []
			const r = writeSegmentedState(dir, makeState({ pending: 4, consumed: 3, exited: 1 }), {
				segmentSize: 2,
				hooks: {
					beforeCommit: () => {
						beforeCommitInodes = [...inodes]
					},
				},
			})
			assert.ok(beforeCommitInodes.includes(fs.statSync(path.join(dir, r.generation)).ino), 'genDir fsynced before commit')
			assert.ok(beforeCommitInodes.includes(fs.statSync(dir).ino), 'parent dir fsynced before commit')
		})
	})
})

test('C3: a failed directory fsync before the commit aborts it; the previous state stays readable', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const a = writeSegmentedState(dir, makeState({ pending: 5, consumed: 6, exited: 2 }), { segmentSize: 2 })
		const stateA = readSegmentedState(dir)
		withDirFsyncSpy({ failDirs: true }, () => {
			assert.throws(
				() => writeSegmentedState(dir, makeState({ pending: 8, consumed: 9, exited: 3 }), { segmentSize: 2 }),
				/simulated EIO on directory fsync/
			)
		})
		assert.deepEqual(readSegmentedState(dir), stateA)
		assert.equal(readManifest(dir).generation, a.generation)
		assert.deepEqual(listGenerationDirs(dir), [a.generation], 'the failed generation is removed')
	})
})

test('B-1: prune removes only generations this process created; a foreign generation and a foreign manifest tmp are kept', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const a = writeSegmentedState(dir, makeState({ pending: 3, consumed: 2, exited: 0 }), { segmentSize: 2 })
		const b = writeSegmentedState(dir, makeState({ pending: 4, consumed: 2, exited: 0 }), { segmentSize: 2 })
		// Written by another process: a valid generation name this process never created, plus a foreign tmp.
		const foreign = 'gen-20261115T120000Z-bbbbbbbbbbbb'
		fs.mkdirSync(path.join(dir, foreign))
		fs.writeFileSync(path.join(dir, foreign, 'pending-000000.jsonl'), '{}\n')
		const foreignTmp = `manifest.json.tmp.${process.pid + 100000}`
		fs.writeFileSync(path.join(dir, foreignTmp), 'staged elsewhere')

		const c = writeSegmentedState(dir, makeState({ pending: 1, consumed: 0, exited: 0 }), { segmentSize: 2 })
		assert.equal(fs.existsSync(path.join(dir, a.generation)), false, 'own generation older than previous is pruned')
		assert.equal(fs.existsSync(path.join(dir, b.generation)), true, 'previous generation is kept')
		assert.equal(fs.existsSync(path.join(dir, c.generation)), true, 'current generation is kept')
		assert.equal(fs.existsSync(path.join(dir, foreign)), true, 'foreign generation is never pruned')
		assert.equal(fs.existsSync(path.join(dir, foreignTmp)), true, 'foreign manifest tmp is never pruned')
		assert.equal(readSegmentedState(dir).pending.length, 1)
	})
})

// R3: the frozen legacy ledger shape (consumed exactly 200,000) round-trips through the v2 store, and one more key is accepted.
// Measured in isolation on 2026-11-18 (200,000 -> 200,001). No cap exists in the store.
test('R3: consumed at exactly 200,000 round-trips and accepts one more key (no store cap)', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const base = makeState({ pending: 3, consumed: 0, exited: 0 })
		const consumedEventKeys: Record<string, true> = {}
		for (let i = 0; i < 200000; i++) consumedEventKeys[hexKey('r3-consumed', i)] = true
		writeSegmentedState(dir, { ...base, consumedEventKeys }, { segmentSize: 5000 })
		const back = readSegmentedState(dir)
		assert.equal(Object.keys(back.consumedEventKeys).length, 200000)
		back.consumedEventKeys[hexKey('r3-new', 0)] = true
		writeSegmentedState(dir, back, { segmentSize: 5000 })
		assert.equal(Object.keys(readSegmentedState(dir).consumedEventKeys).length, 200001)
	})
})

// R4: the migration read path (readFileSync + JSON.parse) on a synthetic legacy-shaped ledger. The real 536,757,415-byte
// copy was measured separately (node --max-old-space-size=3072: read and parse ok, consumed 200,000, peak ~2.29 GB).
test('R4: a synthetic legacy-shaped ledger parses through the same read path (small stand-in, not the real copy)', () => {
	withRoot((root) => {
		const file = path.join(root, 'legacy.json')
		const consumedEventKeys: Record<string, true> = {}
		for (let i = 0; i < 20000; i++) consumedEventKeys[hexKey('r4-consumed', i)] = true
		fs.writeFileSync(file, JSON.stringify({ lastBackfillProcessedBlock: 2009199, consumedEventKeys, exitedPubkeys: {}, pending: [] }))
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { consumedEventKeys: Record<string, true> }
		assert.equal(Object.keys(parsed.consumedEventKeys).length, 20000)
	})
})

// Re-migration guard matrix (dirStatus x legacy file). Only an absent v2 directory may take the legacy path.
test('re-migration guard: legacy file beside an orphan or committed v2 directory is refused; only absent allows migration', () => {
	assert.doesNotThrow(() => assertNoRemigration('absent', true), 'first migration into an absent directory')
	assert.doesNotThrow(() => assertNoRemigration('committed', false), 'v2 state with no legacy file')
	assert.doesNotThrow(() => assertNoRemigration('absent', false))
	assert.throws(() => assertNoRemigration('committed', true), /re-migration is allowed only into an absent directory/)
	assert.throws(() => assertNoRemigration('orphan', true), /legacy single-file state present while the v2 directory is orphan/)
})

// Pruning order survives a segmented round trip (checked by key order, not only by count).
test('prune order: the oldest settled keys are dropped and the survivors keep insertion order through a segmented round trip', () => {
	withRoot((root) => {
		const dir = path.join(root, 'state.v2')
		const all = Array.from({ length: 30 }, (_, i) => hexKey('order', i))
		const consumedEventKeys: Record<string, true> = {}
		for (const k of all) consumedEventKeys[k] = true
		const pendingKeys = new Set([all[0].toLowerCase()]) // the oldest key is still pending and must survive
		const drop = pruneOrder(Object.keys(consumedEventKeys), pendingKeys, 20)
		assert.deepEqual(drop, all.slice(1, 11), 'the 10 oldest non-pending keys are dropped')
		const kept: Record<string, true> = {}
		for (const k of Object.keys(consumedEventKeys)) if (!drop.includes(k)) kept[k] = true
		const base = makeState({ pending: 1, consumed: 0, exited: 0 })
		writeSegmentedState(dir, { ...base, consumedEventKeys: kept }, { segmentSize: 4 })
		const back = readSegmentedState(dir)
		assert.deepEqual(Object.keys(back.consumedEventKeys), [all[0], ...all.slice(11)], 'order preserved after the round trip')
	})
})
