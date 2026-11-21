/**
 * Errata W7: real-process kill -9 of the whole WAL-mode stack (recovery, events, background snapshot cycles, WAL truncation). Each round the child recovers the state directory,
 * runs for a random time and is killed with SIGKILL; the parent recovers the directory too and compares it with the reference (the deterministic event stream 1..K applied to plain
 * Maps). Claims: K >= every acknowledged seq, recovered state == reference at K, no recovery warning, no drift, no mid-log refusal, and the log never has a gap.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { Model, modelView, view } from './labPayoutTestSupport'
import { recoverPayoutState } from './labPayoutRecovery'
import { opsForSeq } from './labWalKillChild'

const rounds = Number(process.env.LAB_KILL_ROUNDS ?? 30)

function runChild(stateDir: string, seed: number, killAfterMs: number): Promise<{ acked: number; recoveredLine: string | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const loader = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
		const child = spawn(process.execPath, [...loader, path.join(__dirname, 'labSnapshotKillChild.ts'), stateDir, String(seed), '1500', '30'], { stdio: ['ignore', 'pipe', 'pipe'] })
		let acked = 0
		let recoveredLine: string | null = null
		let buf = ''
		let err = ''
		child.stdout.on('data', (d: Buffer) => {
			buf += d.toString('utf8')
			let i: number
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i)
				buf = buf.slice(i + 1)
				const m = /^durable (\d+)$/.exec(line)
				if (m) acked = Math.max(acked, Number(m[1]))
				else if (line.startsWith('recovered ')) recoveredLine = line
			}
		})
		child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
		const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs)
		child.on('error', reject)
		child.on('exit', (code, sig) => {
			clearTimeout(timer)
			if (sig !== 'SIGKILL') reject(new Error(`child ended unexpectedly: code ${code} signal ${sig}\n${err}`))
			else resolve({ acked, recoveredLine, stderr: err })
		})
	})
}

test(`W7 kill -9 of the WAL-mode stack (recovery + events + background snapshots + truncation): ${rounds} rounds, recovered state equals the reference and no acknowledged event is lost`, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labkill-'))
	const seed = 4242
	let maxAcked = 0
	let snapshotsSeen = 0
	let r = 99
	const rand = (): number => {
		r = (Math.imul(r, 1664525) + 1013904223) >>> 0
		return r / 0x100000000
	}
	try {
		for (let round = 0; round < rounds; round++) {
			const res = await runChild(dir, seed, 400 + Math.floor(rand() * 900))
			assert.equal(res.stderr, '', `round ${round}: child stderr`)
			maxAcked = Math.max(maxAcked, res.acked)
			const rec = recoverPayoutState(dir)
			assert.deepEqual(rec.warnings, [], `round ${round}`)
			assert.equal(rec.core.counts.driftEvents, 0)
			assert.ok(rec.core.lastAppliedSeq >= maxAcked, `round ${round}: ACKNOWLEDGED EVENT LOST: acked ${maxAcked}, recovered ${rec.core.lastAppliedSeq}`)
			if (rec.snapshotSeq > 0) snapshotsSeen++
			const model = new Model()
			model.setScalar('freezeH', { height: 500 })
			for (let s = 1; s <= rec.core.lastAppliedSeq; s++) model.apply(opsForSeq(seed, s))
			assert.equal(view(rec.core), modelView(model), `round ${round}: state at seq ${rec.core.lastAppliedSeq} equals the reference`)
		}
		assert.ok(maxAcked > 500, `the child made progress (acked ${maxAcked})`)
		assert.ok(snapshotsSeen >= Math.floor(rounds / 3), `snapshots were taken and recovered from (${snapshotsSeen} rounds)`)
		console.log(`# W7 kill rounds=${rounds} maxAcked=${maxAcked} roundsWithSnapshot=${snapshotsSeen}`)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
