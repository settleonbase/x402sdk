/**
 * T1 (P2c-2): the committed history cursor that gates invariant C is only ever set from a value that is DURABLE. In WAL mode `await h.commit(...)` resolves when the log frame is on disk (group
 * commit), so every assignment of labCommittedHistoryCursor must directly follow an awaited commit; reading the scalar before the commit resolved would let history be paid ahead of a cursor
 * a crash could still roll back. Source-level check (the end-to-end proof is the C5 kill test, class after-scan).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

test('every assignment of labCommittedHistoryCursor directly follows an awaited h.commit(...)', () => {
	const src = fs.readFileSync(path.join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8').split('\n')
	const idx: number[] = []
	src.forEach((l, i) => {
		if (/\blabCommittedHistoryCursor\s*=[^=]/.test(l) && !/^\s*let\s/.test(l)) idx.push(i)
	})
	assert.ok(idx.length >= 2, 'the assignments were found (the pattern is stale if this fails)')
	for (const i of idx) {
		let j = i - 1
		while (j >= 0 && (src[j]!.trim() === '' || src[j]!.trim().startsWith('//'))) j--
		assert.match(src[j]!, /await h\.commit\(/, `line ${i + 1}: ${src[i]!.trim()} must directly follow an awaited commit, found: ${src[j]!.trim()}`)
	}
})
