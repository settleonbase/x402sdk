/**
 * Errata W6: a source-level completeness check, so that no code path can read or write the pending / consumed / exited collections behind the layered views and leave the two layers
 * inconsistent.
 *  1. The WAL-mode modules (core, snapshot writer, recovery) touch the collections only through the layered classes: outside labPayoutStateCore.ts no line may call a Map/Set method on a
 *     pending/consumed/exited member, and inside it only `this.pending/consumed/exited` (the layered members) may be used.
 *  2. A ratchet for the daemon wiring that P2c still has to do: the legacy reporter's direct uses are counted per pattern; the count may only go DOWN. P2c lowers each baseline to 0 as it
 *     moves the call sites onto LabPayoutStateCore.record(); a new direct use added before that fails here.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const read = (f: string): string => fs.readFileSync(path.join(__dirname, f), 'utf8')
const stripComments = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.split('\n')
		.map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
		.join('\n')

const MAP_METHODS = '(get|set|has|delete|clear|values|keys|entries|size|forEach|add|merge|abort|freeze)'
/** `<something>.pending.get(`, `<something>.consumed.has(`, `consumedEventKeys[`, `exitedPubkeys[`, bare `pending.get(`. */
export function directAccessLines(src: string): { line: number; text: string; kind: string }[] {
	const out: { line: number; text: string; kind: string }[] = []
	const lines = stripComments(src).split('\n')
	lines.forEach((text, i) => {
		const t = text.trim()
		if (new RegExp(`\\b(pending|consumed|exited)\\.${MAP_METHODS}\\b`).test(t)) out.push({ line: i + 1, text: t, kind: 'collection-method' })
		if (/\b(consumedEventKeys|exitedPubkeys)\b/.test(t)) out.push({ line: i + 1, text: t, kind: 'legacy-record' })
		if (/\bpersistPending\(/.test(t)) out.push({ line: i + 1, text: t, kind: 'persistPending' })
	})
	return out
}

test('W6 scanner: finds direct Map/Record access, ignores comments (self test on fixtures)', () => {
	const src = [
		'// pending.get( in a comment is not code',
		'const a = pending.get(k)',
		'state.consumedEventKeys[k] = true',
		'/* exitedPubkeys[k] */ const b = 1',
		'this.pending.set(k, v)',
		'persistPending(state, pending)',
		'const ok = core.pendingHas(k)',
	].join('\n')
	const hits = directAccessLines(src)
	assert.deepEqual(hits.map((h) => `${h.line}:${h.kind}`), ['2:collection-method', '3:legacy-record', '5:collection-method', '6:persistPending'])
})

test('W6 the WAL-mode modules reach the collections only through the layered classes: the snapshot writer and the recovery module have no direct collection access; the core uses only its own layered members', () => {
	for (const f of ['labSnapshotWriter.ts', 'labPayoutRecovery.ts']) {
		const hits = directAccessLines(read(f)).filter((h) => h.kind !== 'persistPending')
		// the writer reads the FROZEN handles (src.pending.entries()/.view/.isValid()): that is the layered API, not a bypass
		const bad = hits.filter((h) => !/\bsrc\.(pending|consumed|exited)\.(entries|isValid|view|token)\b/.test(h.text) && !/\bstate\.(pending|consumedEventKeys|exitedPubkeys)\b/.test(h.text) && !/Object\.keys\(state\.(consumedEventKeys|exitedPubkeys)\)/.test(h.text) && !/^const NOT_SCALARS\b/.test(h.text))
		assert.deepEqual(bad, [], `${f}: ${bad.map((b) => `${b.line}: ${b.text}`).join(' | ')}`)
	}
	const core = directAccessLines(read('labPayoutStateCore.ts')).filter((h) => h.kind === 'collection-method')
	const stray = core.filter((h) => !/\bthis\.(pending|consumed|exited)\.\w+/.test(h.text) && !/\bsrc\.(pending|consumed|exited)\.token\b/.test(h.text))
	assert.deepEqual(stray, [], `labPayoutStateCore.ts: ${stray.map((b) => `${b.line}: ${b.text}`).join(' | ')}`)
	// the members must really be the layered classes, not Map/Set
	const coreSrc = read('labPayoutStateCore.ts')
	assert.match(coreSrc, /readonly pending = new LayeredMap</)
	assert.match(coreSrc, /readonly consumed = new LayeredSet</)
	assert.match(coreSrc, /readonly exited = new LayeredSet</)
	assert.doesNotMatch(stripComments(coreSrc), /new (Map|Set)<string, PendingEntry>/)
})

test('W6: the reporter has NO direct access to the pending / consumed / exited collections and no direct call of the whole-state persistence; it does not import the state store readers or writers (the legacy implementation lives in labLegacyState.ts)', () => {
	const src = read('validatorLabMiningPoolClPayoutReporter.ts')
	const hits = directAccessLines(src)
	assert.deepEqual(hits.map((h) => `${h.line}:${h.kind}:${h.text}`), [], 'no direct collection access, no legacy record, no persistPending call in the reporter')
	const code = stripComments(src)
	assert.doesNotMatch(code, /\b(readSegmentedState|writeSegmentedState|inspectSegmentedDir|legacyStateFileExists)\b/, 'the reporter does not use the state store directly')
	assert.doesNotMatch(code, /\bstate\.pending\b|\.consumedEventKeys\b|\.exitedPubkeys\b/)
	// the legacy implementation is the ONE place that may touch them
	const legacy = read('labLegacyState.ts')
	assert.match(legacy, /readSegmentedState/)
	assert.match(legacy, /writeSegmentedState/)
	// the handle's two implementations (legacy now, WAL in P2c-2) are the only other readers of the collections
	for (const f of ['labStateHandle.ts']) assert.ok(read(f).length > 0)
})
