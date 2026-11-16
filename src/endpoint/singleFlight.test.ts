import assert from 'node:assert/strict'
import test from 'node:test'
import { createSingleFlight } from './singleFlight.ts'

const gate = () => {
	let open!: () => void
	const p = new Promise<void>((resolve) => {
		open = resolve
	})
	return { p, open }
}

test('concurrent calls with the same key share one computation', async () => {
	const sf = createSingleFlight<number>()
	let calls = 0
	const g = gate()
	const fn = async () => {
		calls += 1
		await g.p
		return 42
	}
	const results = Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)])
	await new Promise((r) => setTimeout(r, 5))
	assert.equal(sf.inFlightCount(), 1)
	g.open()
	assert.deepEqual(await results, [42, 42, 42])
	assert.equal(calls, 1, 'the computation must run once for concurrent callers')
})

test('different keys are computed independently', async () => {
	const sf = createSingleFlight<string>()
	let calls = 0
	const fn = (v: string) => async () => {
		calls += 1
		return v
	}
	assert.deepEqual(await Promise.all([sf.run('a', fn('A')), sf.run('b', fn('B'))]), ['A', 'B'])
	assert.equal(calls, 2)
})

test('after completion the key is released and the next call recomputes', async () => {
	const sf = createSingleFlight<number>()
	let calls = 0
	const fn = async () => ++calls
	assert.equal(await sf.run('k', fn), 1)
	assert.equal(sf.inFlightCount(), 0)
	assert.equal(await sf.run('k', fn), 2)
})

test('a failed computation is shared by its concurrent callers and then released', async () => {
	const sf = createSingleFlight<number>()
	let calls = 0
	const g = gate()
	const fn = async () => {
		calls += 1
		await g.p
		throw new Error('boom')
	}
	const a = sf.run('k', fn)
	const b = sf.run('k', fn)
	g.open()
	await assert.rejects(a, /boom/)
	await assert.rejects(b, /boom/)
	assert.equal(calls, 1)
	assert.equal(sf.inFlightCount(), 0)
})

test('a synchronously throwing computation does not leave a stale in-flight entry', async () => {
	const sf = createSingleFlight<number>()
	await assert.rejects(sf.run('k', () => { throw new Error('sync') }), /sync/)
	assert.equal(sf.inFlightCount(), 0)
})
