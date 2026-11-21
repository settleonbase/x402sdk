/**
 * P2c-1 (errata C3): the lifecycle's persist is asynchronous. A rejected or slow persist is B-2 fail-closed: nothing is sent after it, the gate trips, and every persistOrTrip is awaited.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { LabPayoutFailClosedGate } from './labClPayoutFailClosed'
import { submitWithdrawBatchDurably, resumeLabWithdrawInFlight, type LabInFlightWithdraw, type LabLifecycleDeps, type LabPersistStep } from './labClPayoutBatchLifecycle'
import { LAB_MINING_POOL_FIXED } from './labMiningPoolPayoutSigner'

const REDEEM = '0x2222222222222222222222222222222222222222'
const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function make(opts: { rejectAt?: LabPersistStep; delayMs?: number; sendFails?: boolean } = {}) {
	const events: string[] = []
	let inFlight: LabInFlightWithdraw | null = null
	const gate = new LabPayoutFailClosedGate((m) => events.push(`alert:${m.slice(0, 20)}`))
	const deps: LabLifecycleDeps = {
		gate,
		getInFlight: () => inFlight,
		setInFlight: (v) => {
			inFlight = v
		},
		persist: async (step) => {
			events.push(`persist:${step}:start`)
			if (opts.delayMs) await wait(opts.delayMs)
			if (opts.rejectAt === step) {
				events.push(`persist:${step}:reject`)
				throw new Error(`persist ${step} refused`)
			}
			events.push(`persist:${step}:done`)
		},
		send: async (rec) => {
			events.push('send')
			if (opts.sendFails) throw new Error('send failed')
			return { hash: '0x' + 'ab'.repeat(32) + rec.idempotencyKey.slice(0, 0) }
		},
		waitReceipt: async () => {
			events.push('waitReceipt')
			return { status: 1 }
		},
		settle: () => {
			events.push('settle')
		},
		confirmBeforeSend: async () => {
			events.push('confirm')
		},
		log: () => undefined,
	}
	const req = { redeem: REDEEM, pool: LAB_MINING_POOL_FIXED, amount: 3000n, eventKeys: [key(1), key(2)], line: 'history' as const }
	return { events, deps, req, gate, state: () => inFlight }
}

test('C3: a slow persist (async) delays the send: the send happens only after the intent persist resolved, in that order', async () => {
	const w = make({ delayMs: 15 })
	const out = await submitWithdrawBatchDurably(w.deps, w.req)
	assert.equal(out, 'settled')
	const i = (e: string): number => w.events.indexOf(e)
	assert.ok(i('persist:intent:done') < i('send'), 'send after the intent is durable')
	assert.ok(i('persist:hash:done') < i('waitReceipt'), 'receipt wait after the hash is durable')
	assert.ok(i('persist:settle:done') > i('settle'), 'the settle persist comes after the in-memory settle')
	assert.deepEqual(
		w.events.filter((e) => e.startsWith('persist:') && e.endsWith(':start')).map((e) => e.split(':')[1]),
		['intent', 'hash', 'settle']
	)
})

test('C3: a rejected intent persist - nothing is sent, the gate trips, the record is withdrawn from memory', async () => {
	const w = make({ rejectAt: 'intent' })
	await assert.rejects(submitWithdrawBatchDurably(w.deps, w.req), /persist intent refused/)
	assert.ok(!w.events.includes('send'), 'no send after a refused intent persist')
	assert.equal(w.gate.tripped, true)
	assert.equal(w.state(), null)
})

test('C3: a rejected hash persist - the single send already happened, nothing more is done (no receipt wait, no settle, no second send), the gate trips', async () => {
	const w = make({ rejectAt: 'hash' })
	await assert.rejects(submitWithdrawBatchDurably(w.deps, w.req), /persist hash refused/)
	assert.equal(w.events.filter((e) => e === 'send').length, 1)
	assert.ok(!w.events.includes('waitReceipt') && !w.events.includes('settle'))
	assert.equal(w.gate.tripped, true)
})

test('C3: a rejected settle persist - the gate trips and no further send happens; the in-memory record is cleared only by the lifecycle, the caller sees the failure', async () => {
	const w = make({ rejectAt: 'settle' })
	await assert.rejects(submitWithdrawBatchDurably(w.deps, w.req), /persist settle refused/)
	assert.equal(w.gate.tripped, true)
	assert.equal(w.events.filter((e) => e === 'send').length, 1)
	// a later resume under a tripped gate holds: it sends nothing
	const before = w.events.length
	assert.ok(['none', 'pending'].includes(await resumeLabWithdrawInFlight(w.deps)), 'nothing is resumed or re-sent under a tripped gate')
	assert.equal(w.events.slice(before).filter((e) => e === 'send' || e === 'waitReceipt').length, 0)
})

test('C3: a rejected release persist (refused before broadcast) is surfaced and trips the gate', async () => {
	const w = make({ rejectAt: 'release' })
	w.deps.send = async () => {
		const { LabRefusedBeforeBroadcast } = await import('./labClPayoutBatchLifecycle')
		throw new LabRefusedBeforeBroadcast('bound address changed')
	}
	await assert.rejects(submitWithdrawBatchDurably(w.deps, w.req), /persist release refused/)
	assert.equal(w.gate.tripped, true)
})

test('C3 source check: every persistOrTrip( call in the lifecycle is awaited, and no bare deps.persist( call exists outside persistOrTrip', () => {
	const src = fs.readFileSync(path.join(__dirname, 'labClPayoutBatchLifecycle.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
	const calls = [...src.matchAll(/(await\s+)?persistOrTrip\(/g)].filter((m) => !src.slice(Math.max(0, (m.index ?? 0) - 22), m.index).includes('function'))
	assert.ok(calls.length >= 5)
	for (const m of calls) assert.ok(m[1], `persistOrTrip call at ${m.index} is not awaited`)
	const direct = [...src.matchAll(/deps\.persist\(/g)]
	assert.equal(direct.length, 1, 'only persistOrTrip itself calls deps.persist')
})
