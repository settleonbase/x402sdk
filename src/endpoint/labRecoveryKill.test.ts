/**
 * P2d M5, kill point "during the recovery read": a recovery that is killed with SIGKILL while it reads the snapshot (the V8 out-of-memory abort and the cgroup kill both end a recovery this
 * way) must leave the state directory usable.
 *   - read-only recovery (what the offline tools use): the directory is BYTE-IDENTICAL afterwards (tree hash before == after), for kills at spread moments of the read phase;
 *   - the daemon's real recovery (it truncates a torn tail and removes log segments the snapshot covers AFTER the replay): after any kill, a fresh recovery gives the same logical state as before
 *     (the clean-up is idempotent), and a killed recovery never leaves the directory in a state the next recovery refuses.
 * Real processes, real kill -9, both loaders.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { canonicalJson } from './labClPayoutStateStore'
import { LabPayoutStateCore, type PendingEntry } from './labPayoutStateCore'
import { recoverPayoutState } from './labPayoutRecovery'
import { writeSnapshotCooperative } from './labSnapshotWriter'
import { WalWriter } from './labWal'

const hex = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`

function treeHash(dir: string): string {
	const h = createHash('sha256')
	const walk = (d: string): void => {
		for (const n of fs.readdirSync(d).sort()) {
			const f = path.join(d, n)
			const st = fs.statSync(f)
			if (st.isDirectory()) {
				h.update(`D:${f.slice(dir.length)}\n`)
				walk(f)
			} else {
				h.update(`F:${f.slice(dir.length)}:${st.size}\n`).update(fs.readFileSync(f))
			}
		}
	}
	walk(dir)
	return h.digest('hex')
}
const logical = (dir: string): string => {
	const r = recoverPayoutState(dir, { readOnly: true })
	const c = r.core
	return canonicalJson({ scalars: c.scalarsCopy(), inFlight: c.getInFlight(), pending: [...c.pendingEntries()].map((e) => ({ ...e })).sort((a, b) => (a.eventKey < b.eventKey ? -1 : 1)), consumed: [...c.consumedKeys()], exited: [...c.exited.keys()].sort(), seq: c.lastAppliedSeq })
}

/** A directory whose recovery takes a good fraction of a second and, for the daemon's variant, has log segments that the snapshot already covers (removed after the replay). */
async function bigDir(): Promise<{ root: string; dir: string }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labreckill-'))
	const dir = path.join(root, 'state.v2')
	const N = 220_000
	const pending = Array.from({ length: N }, (_, i) => ({ eventKey: hex(0x100000 + i), amount: String(1_000_000_000_000_000_000_000n + BigInt(i)), blockNumber: 2_000_000 + Math.floor(i / 13), withdrawalIndex: i % 13, pubkey: '0x' + 'ab'.repeat(48) })) as PendingEntry[]
	const consumed = Array.from({ length: 330_000 }, (_, i) => hex(0x9000000 + i))
	const core = new LabPayoutStateCore({ pending, consumed, scalars: { freezeH: { height: 2_000_000 + Math.floor((N * 0.9) / 13) } } })
	const s0 = core.freezeForSnapshot()
	const r0 = await writeSnapshotCooperative(s0, { dir, mode: 'wal', sliceMs: 1000 })
	core.finishSnapshot(s0, { committed: true, prunedKeys: [], frozenHistCounts: r0.frozenHistCounts })
	const wal = new WalWriter({ stateDir: dir, lastSeq: 0, segmentBytes: 20_000 })
	const ps: Promise<void>[] = []
	for (let e = 0; e < 400; e++) ps.push(core.record(wal, 'scan', [{ op: 'consumedAdd', key: hex(0xb000000 + e) }, { op: 'pendingDel', key: hex(0x100000 + e) }]).durable)
	await Promise.all(ps)
	await wal.close()
	// a second snapshot at the end of the log, WITHOUT truncating: every segment is now covered and the daemon's recovery will remove them
	const s1 = core.freezeForSnapshot()
	const r1 = await writeSnapshotCooperative(s1, { dir, mode: 'wal', sliceMs: 1000 })
	core.finishSnapshot(s1, { committed: true, prunedKeys: [], frozenHistCounts: r1.frozenHistCounts })
	return { root, dir }
}

function killedRecovery(dir: string, readOnly: boolean, loader: 'stream' | 'whole', delayMs: number): Promise<{ killed: boolean; finished: boolean }> {
	const loaderArgs = process.execArgv.some((a) => a.includes('tsx')) ? [...process.execArgv] : ['--import', pathToFileURL(join(dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href]
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [...loaderArgs, path.join(__dirname, 'labRecoveryKillChild.ts'), dir, readOnly ? '1' : '0', loader], { stdio: ['ignore', 'pipe', 'pipe'] })
		let out = ''
		let err = ''
		let timer: NodeJS.Timeout | undefined
		child.stdout.on('data', (d: Buffer) => {
			out += d.toString('utf8')
			if (!timer && out.includes('READY')) timer = setTimeout(() => child.kill('SIGKILL'), delayMs)
		})
		child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')))
		child.on('exit', (code, sig) => {
			if (timer) clearTimeout(timer)
			if (sig === 'SIGKILL') return resolve({ killed: true, finished: out.includes('DONE') })
			if (code === 0 && out.includes('DONE')) return resolve({ killed: false, finished: true })
			reject(new Error(`recovery child ended unexpectedly: code ${code} signal ${sig}\n${err.slice(-400)}`))
		})
	})
}

for (const loader of ['stream', 'whole'] as const) {
	test(`kill -9 during the READ-ONLY recovery read (${loader} loader): the directory is byte-identical afterwards`, { timeout: 280_000 }, async () => {
		const { root, dir } = await bigDir()
		try {
			const before = treeHash(dir)
			// control: the hash CAN see a change - a completed non-read-only recovery of a COPY removes the covered log segments, so its tree hash differs
			const copy = path.join(root, 'copy.v2')
			fs.cpSync(dir, copy, { recursive: true })
			recoverPayoutState(copy, { readOnly: false })
			assert.notEqual(treeHash(copy), before, 'control: a non-read-only recovery changes the directory, so the byte comparison below is able to fail')
			fs.rmSync(copy, { recursive: true, force: true })
			let killed = 0
			for (const delay of [0, 20, 60, 120, 200, 300, 450, 700, 1000, 1400]) {
				const r = await killedRecovery(dir, true, loader, delay)
				if (r.killed && !r.finished) killed++
				assert.equal(treeHash(dir), before, `directory changed after a kill at +${delay} ms`)
			}
			assert.ok(killed >= 5, `at least 5 of 10 kills really landed before the recovery finished (${killed}); raise the data size if not`)
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
}

test('kill -9 during the DAEMON recovery (not read-only: it removes covered log segments after the replay): after every kill the next recovery gives the same logical state', { timeout: 280_000 }, async () => {
	const { root, dir } = await bigDir()
	try {
		const want = logical(dir)
		let killed = 0
		for (const delay of [0, 40, 150, 300, 500, 800, 1100, 1500, 2000]) {
			const r = await killedRecovery(dir, false, 'stream', delay)
			if (r.killed && !r.finished) killed++
			assert.equal(logical(dir), want, `the state recovered after a kill at +${delay} ms differs`)
		}
		// finally a recovery that is allowed to finish: it cleans up, and the state is still the same
		const done = await killedRecovery(dir, false, 'stream', 60_000)
		assert.equal(done.finished, true)
		assert.equal(logical(dir), want)
		assert.ok(killed >= 4, `at least 4 of 9 kills really landed before the recovery finished (${killed})`)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})
