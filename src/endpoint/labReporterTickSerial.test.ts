/**
 * P2c-1 (errata C4): with awaited persists the tick yields a microtask turn where it did not before. These source-level checks pin what keeps the behaviour safe:
 * ticks never overlap (a guard that is set before the first await and a scheduler that re-arms only after the previous tick finished), every commit/persist is awaited (except the one
 * synchronous halt flush), and the one-shot send gate is re-read after the intent persist and before every send.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const read = (f: string): string => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('C4: ticks cannot overlap - the guard is set before the first await and released in finally; the next tick is armed only after the previous one finished', () => {
	const src = read('validatorLabMiningPoolClPayoutReporter.ts')
	// since the tick-loop patch the tick body is labPayoutTickBody (labPayoutTick wraps it in the RPC source tag) and it returns an outcome
	const tick = src.slice(src.indexOf('async function labPayoutTickBody()'), src.indexOf('One payment pass of the decoupled worker'))
	assert.match(tick, /if \(labInFlight\) return 'skipped'/)
	const guardAt = tick.indexOf('labInFlight = true')
	const firstAwait = tick.indexOf('await ')
	assert.ok(guardAt > 0 && guardAt < firstAwait, 'the in-flight guard is set before the first await')
	assert.match(tick, /finally \{\s*tickHandle\?\.exitTick\(\)\s*labInFlight = false\s*labWalSession\?\.scheduler\.poke\(\)\s*\}/, 'the guard is released first, then the snapshot scheduler is poked (it never throws)')
	// the next tick is armed by LabTickLoop only after the previous tick function returned (labTickLoop.test.ts proves it behaviourally); the reporter starts it once per start path
	const loop = read('labTickLoop.ts')
	assert.ok(loop.indexOf('outcome = await this.d.tick()') > 0 && loop.indexOf('outcome = await this.d.tick()') < loop.indexOf('this.arm(gen, outcome)'), 'the loop awaits the tick before it arms the next one')
	assert.equal([...src.matchAll(/labLoop\.start\(\)/g)].length, 2, 'both start paths (plain and WAL) start the loop')
	assert.equal(src.includes('scheduleNextLabTick'), false, 'no fixed-interval re-arm is left')
})

test('C4: every state commit in the reporter is awaited; the only synchronous flush is the halt path before process.exit', () => {
	const src = read('validatorLabMiningPoolClPayoutReporter.ts')
	const commits = [...src.matchAll(/(await\s+)?h\.commit\(/g)].filter((m) => !src.slice(Math.max(0, (m.index ?? 0) - 18), m.index).includes('(step) =>'))
	assert.ok(commits.length >= 10, `commit call sites ${commits.length}`)
	for (const m of commits) assert.ok(m[1], `h.commit( at ${m.index} is not awaited`)
	assert.equal([...src.matchAll(/h\.haltFlush\(/g)].length, 1)
	assert.match(src, /persist: \(step\) => h\.commit\(step\)/, 'the lifecycle persist returns the commit promise (awaited by the lifecycle)')
})

test('C4: the one-shot send gate is evaluated after the awaited intent persist (resume checks it first thing) and before every send', () => {
	const life = read('labClPayoutBatchLifecycle.ts')
	const submit = life.slice(life.indexOf('export async function submitWithdrawBatchDurably'))
	const persistAt = submit.indexOf("await persistOrTrip(deps, 'persist intent'")
	const resumeAt = submit.lastIndexOf('return resumeLabWithdrawInFlight(deps)')
	assert.ok(persistAt > 0 && resumeAt > persistAt, 'the intent persist is awaited, then the lifecycle resumes')
	const resume = life.slice(life.indexOf('export async function resumeLabWithdrawInFlight'), life.indexOf('export async function submitWithdrawBatchDurably'))
	const gateAt = resume.indexOf('deps.stopBeforeSend?.()')
	const sendAt = resume.indexOf('await deps.send(rec)')
	assert.ok(gateAt > 0 && gateAt < resume.indexOf('await deps.confirmBeforeSend()') && gateAt < sendAt, 'the gate is checked before the confirmation await and before the send')
})
