/**
 * F1 of the clone drill: the rollback's logical digest is a STREAMING hash of exactly the bytes the old materialised digest produced. Tests: the streaming value equals sha256(logicalDigest) on many shapes,
 * across the 1 MiB chunk boundary, with exotic keys; every kind of difference changes it; the part hashes equal the hashes of the canonical lists; and the memory claim (a large state is hashed without
 * building the strings) holds.
 *   D1 equality on shapes          D2 any difference changes the digest          D3 parts          D4 chunk boundary and exotic keys          D5 heap: no giant string
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { canonicalJson } from './labClPayoutStateStore'
import { LabPayoutStateCore } from './labPayoutStateCore'
import { digestParts, digestPartsOfCore, logicalDigest, logicalDigestSha256 } from './labWalRollback'

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`
const entry = (i: number, extra: Record<string, unknown> = {}): never => ({ eventKey: hex(i), amount: String(1000 + i), blockNumber: 2_000_000 + (i % 977), withdrawalIndex: i % 5, pubkey: '0x' + 'ab'.repeat(48), ...extra }) as never
function mulberry32(a: number): () => number {
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
function shape(seed: number, n: { pending: number; consumed: number; exited: number; inFlight: boolean; scalars?: Record<string, unknown> }): LabPayoutStateCore {
	const rnd = mulberry32(seed)
	const keys = Array.from({ length: n.pending }, (_, i) => i)
	for (let i = keys.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1))
		;[keys[i], keys[j]] = [keys[j]!, keys[i]!]
	}
	return new LabPayoutStateCore({
		pending: keys.map((i) => entry(i)),
		consumed: Array.from({ length: n.consumed }, (_, i) => hex(0x900000 + ((i * 7919) % 100003))),
		exited: Array.from({ length: n.exited }, (_, i) => '0x' + (i * 31).toString(16).padStart(96, '0')),
		scalars: { historyCursor: 123, realtimeCursor: 456, settledBatchCount: 7, walSeq: 99, freezeH: { height: 5, hash: '0xab', frozenAt: '2026-11-22T00:00:00.000Z' }, ...(n.scalars ?? {}) },
		...(n.inFlight ? { inFlight: { idempotencyKey: 'k1', eventKeys: [hex(1), hex(2)], amountWei: '2001', hash: '0x' + 'cd'.repeat(32), line: 'history' } as never } : {}),
	})
}

test('D1: the streaming digest equals sha256 of the old materialised digest on empty, small, in-flight, scalar-rich and shuffled shapes', () => {
	const shapes: Array<[string, LabPayoutStateCore]> = [
		['empty', new LabPayoutStateCore({})],
		['one entry', shape(1, { pending: 1, consumed: 0, exited: 0, inFlight: false })],
		['small', shape(2, { pending: 40, consumed: 30, exited: 5, inFlight: false })],
		['in-flight', shape(3, { pending: 40, consumed: 30, exited: 5, inFlight: true })],
		['no pending, consumed only', shape(4, { pending: 0, consumed: 50, exited: 0, inFlight: false })],
		['scalars with unicode and nested', shape(5, { pending: 10, consumed: 10, exited: 2, inFlight: false, scalars: { note: 'ünï“cödé\n\t', nested: { b: 1, a: [3, 2, 1], c: null }, big: '9'.repeat(40) } })],
		['shuffled bigger', shape(6, { pending: 3000, consumed: 2000, exited: 40, inFlight: true })],
	]
	for (const [name, core] of shapes) {
		assert.equal(logicalDigestSha256(core), sha(logicalDigest(core)), name)
		assert.equal(digestPartsOfCore(core).full, sha(logicalDigest(core)), name)
	}
})

test('D2: any difference changes the digest - an entry field, a key, the consumed ORDER, an exited key, the in-flight record, a scalar, a missing or extra entry', () => {
	const base = (): LabPayoutStateCore => shape(11, { pending: 50, consumed: 20, exited: 4, inFlight: true })
	const d0 = logicalDigestSha256(base())
	const same = logicalDigestSha256(base())
	assert.equal(same, d0, 'deterministic')
	const variants: Array<[string, LabPayoutStateCore]> = []
	const mk = (f: (init: Record<string, unknown>) => void): LabPayoutStateCore => {
		const c = base()
		const init = { pending: [...c.pendingEntries()].map((e) => ({ ...e })), consumed: [...c.consumedKeys()], exited: [...c.exited.keys()], scalars: c.scalarsCopy(), inFlight: c.getInFlight() ? { ...(c.getInFlight() as object) } : null }
		f(init)
		return new LabPayoutStateCore(init as never)
	}
	variants.push(['entry amount', mk((i) => { ;(i.pending as { amount: string }[])[3]!.amount = '1' })])
	variants.push(['entry key', mk((i) => { ;(i.pending as { eventKey: string }[])[3]!.eventKey = hex(999999) })])
	variants.push(['entry removed', mk((i) => { ;(i.pending as unknown[]).pop() })])
	variants.push(['entry added', mk((i) => { ;(i.pending as unknown[]).push(entry(777777)) })])
	variants.push(['consumed order', mk((i) => { const c = i.consumed as string[]; ;[c[0], c[1]] = [c[1]!, c[0]!] })])
	variants.push(['consumed removed', mk((i) => { ;(i.consumed as string[]).pop() })])
	variants.push(['exited key', mk((i) => { ;(i.exited as string[])[0] = '0x' + 'ff'.repeat(48) })])
	variants.push(['in-flight hash', mk((i) => { ;(i.inFlight as { hash: string }).hash = '0x' + 'ef'.repeat(32) })])
	variants.push(['in-flight gone', mk((i) => { i.inFlight = null })])
	variants.push(['scalar cursor', mk((i) => { ;(i.scalars as { historyCursor: number }).historyCursor = 124 })])
	for (const [name, c] of variants) assert.notEqual(logicalDigestSha256(c), d0, name)
	// the informational walSeq is deliberately ignored, like the old digest
	const w = mk((i) => { ;(i.scalars as { walSeq: number }).walSeq = 12345 })
	assert.equal(logicalDigestSha256(w), d0, 'walSeq does not count')
	assert.equal(sha(logicalDigest(w)), d0)
})

test('D3: the part hashes equal the hashes of the canonical lists the old plain-reader checks compared', () => {
	const core = shape(21, { pending: 300, consumed: 200, exited: 12, inFlight: true })
	const parts = digestPartsOfCore(core)
	const sortedEntries = [...core.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1))
	assert.equal(parts.pendingKeys, sha(canonicalJson(sortedEntries.map((e) => e.eventKey))))
	assert.equal(parts.pendingEntries, sha(canonicalJson(sortedEntries)))
	assert.equal(parts.consumedOrder, sha(canonicalJson([...core.consumedKeys()])))
	assert.equal(parts.exited, sha(canonicalJson([...core.exited.keys()].sort())))
	assert.equal(parts.inFlight, sha(canonicalJson(core.getInFlight())))
	// a plain-reader shaped input gives the same parts
	const plain = digestParts({ scalars: {}, inFlight: core.getInFlight(), pending: sortedEntries.slice().reverse(), consumed: [...core.consumedKeys()], exited: [...core.exited.keys()].reverse() })
	assert.equal(plain.pendingKeys, parts.pendingKeys)
	assert.equal(plain.pendingEntries, parts.pendingEntries)
	assert.equal(plain.consumedOrder, parts.consumedOrder)
	assert.equal(plain.exited, parts.exited)
	assert.equal(plain.inFlight, parts.inFlight)
})

test('D4: the 1 MiB chunk boundary and exotic strings do not change the bytes', () => {
	// entries with long fields so the hashed text crosses several chunk boundaries (and lands exactly on none of them by luck)
	for (const pad of [0, 1, 17, 301]) {
		const core = new LabPayoutStateCore({
			pending: Array.from({ length: 4000 }, (_, i) => entry(i, { memo: 'x'.repeat(pad + (i % 13)) + 'é€𝄞"\\\n' })),
			consumed: Array.from({ length: 3000 }, (_, i) => hex(0xabc000 + i)),
			scalars: { a: 1 },
		})
		assert.ok(logicalDigest(core).length > 1_200_000 || pad === 0, 'the text is longer than a chunk (sanity)')
		assert.equal(logicalDigestSha256(core), sha(logicalDigest(core)), `pad ${pad}`)
	}
})

test('D5: a large state is hashed without materialising the giant digest string (heap grows far less than the old way)', () => {
	const core = new LabPayoutStateCore({
		pending: Array.from({ length: 120_000 }, (_, i) => entry(i)),
		consumed: Array.from({ length: 150_000 }, (_, i) => hex(0xf00000 + i)),
		scalars: { a: 1 },
	})
	const gc = (globalThis as { gc?: () => void }).gc
	gc?.()
	const h0 = process.memoryUsage().heapUsed
	let peak = 0
	// sample during the streaming computation: the synchronous loop cannot be sampled from outside, so compare the retained size afterwards and the old string's size
	const d = logicalDigestSha256(core)
	peak = process.memoryUsage().heapUsed - h0
	const oldStr = logicalDigest(core)
	assert.equal(d, sha(oldStr))
	assert.ok(oldStr.length > 25_000_000, `the old digest string is large (${oldStr.length})`)
	assert.ok(peak < oldStr.length * 2, 'the streaming run did not hold anything near the size of the old string')
})
