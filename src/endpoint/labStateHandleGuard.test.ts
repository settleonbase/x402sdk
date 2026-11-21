/**
 * Design T1: commit scopes and the serial-tick assertion, on the legacy implementation (the WAL implementation shares the same HandleGuard base and gets the same tests in its own file).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HandleGuard, LegacyStateHandle } from './labStateHandle'

type E = { eventKey: string; blockNumber: number; withdrawalIndex: number }
function make(): { h: LegacyStateHandle<E, Record<string, unknown>>; persisted: number } {
	const box = { persisted: 0 }
	const h = new LegacyStateHandle<E, Record<string, unknown>>({
		state: { consumedEventKeys: {}, exitedPubkeys: {} } as never,
		pending: new Map(),
		persist: () => void box.persisted++,
	})
	return { h, get persisted() { return box.persisted } } as never
}

test('scan scope: only commit(scan) is allowed while it is open and it closes the scope; any other label is refused', async () => {
	const { h } = make()
	h.openScope('scan')
	await assert.rejects(h.commit('settle'), /commit scope 'scan' is open; commit 'settle' refused/)
	await assert.rejects(h.commit('scalars'), /commit scope 'scan' is open/)
	await h.commit('scan')
	assert.equal(h.openScopeLabel, null, 'a commit with the scope\'s own label closes it')
	await h.commit('scalars') // fine now
})

test('batch scope: only the lifecycle steps may commit; it stays open across them and is closed by closeScope', async () => {
	const { h } = make()
	h.openScope('batch')
	for (const l of ['intent', 'hash', 'settle', 'release'] as const) await h.commit(l)
	assert.equal(h.openScopeLabel, 'batch', 'a batch scope covers several steps')
	await assert.rejects(h.commit('scan'), /commit scope 'batch' is open; commit 'scan' refused/)
	await assert.rejects(h.commit('drop'), /refused/)
	h.closeScope()
	await h.commit('drop')
})

test('a scope cannot be opened twice; closing is idempotent; leaving a scope without a commit keeps the writes (the next commit of any label carries them)', async () => {
	const { h } = make()
	h.openScope('scan')
	assert.throws(() => h.openScope('batch'), /already open/)
	h.consumedAdd('0xk1') // a write inside the window ...
	h.closeScope() // ... the window threw: the finally closes the scope without a commit
	h.closeScope()
	assert.equal(h.consumedHas('0xk1'), true, 'the write is still applied in memory')
	await h.commit('scalars') // and the next commit (whatever its label) persists it
})

test('serial tick assertion: enterTick twice throws, exitTick releases, requireIdle refuses while a tick runs', () => {
	const g = new HandleGuard()
	g.enterTick()
	assert.throws(() => g.enterTick(), /ticks must be serial/)
	assert.throws(() => g.requireIdle(), /a tick is still running/)
	g.exitTick()
	assert.doesNotThrow(() => g.requireIdle())
	g.enterTick()
	g.exitTick()
})

test('the reporter wires the scopes and the tick assertion: scan window and flush batch open a scope and close it in a finally; the tick enters and exits the handle', async () => {
	const fs = await import('node:fs')
	const path = await import('node:path')
	const src = fs.readFileSync(path.join(__dirname, 'validatorLabMiningPoolClPayoutReporter.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
	assert.match(src, /h\.openScope\('scan'\)\s*try \{\s*return await scanWindowAndAdvanceInner[\s\S]*?finally \{\s*h\.closeScope\(\)/)
	assert.match(src, /h\.openScope\('batch'\)[\s\S]*?finally \{\s*h\.closeScope\(\)/)
	assert.match(src, /tickHandle = h\s*h\.enterTick\(\)/)
	assert.match(src, /finally \{\s*tickHandle\?\.exitTick\(\)\s*labInFlight = false/)
})
