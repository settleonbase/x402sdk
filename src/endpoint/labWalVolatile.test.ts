/**
 * Review Z3 (errata W7): the WAL writer against a filesystem double with a VOLATILE PAGE CACHE. Written bytes live in the cache until fsync; a new file or a removed file is visible
 * in the directory cache until the directory is fsynced. A "crash" keeps only what was fsynced (plus, for the unsynced tail of a file, a random torn prefix or garbage), and the real
 * recovery scan then runs on that image. The claim under test: every event whose durable promise resolved survives, the log is a contiguous prefix of the event stream, and no
 * acknowledged event is ever lost - including events in a freshly rotated segment (file fsync + directory fsync before the first ack).
 * A sensitivity check turns the directory fsync (and, separately, the file fsync) into a no-op and requires the same harness to report losses.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { opsForSeq } from './labWalKillChild'
import { WAL_DIR, WalWriter, scanWal, type WalFs } from './labWal'

function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
}

type VFile = { durable: Buffer; cache: Buffer }
class VolatileFs implements WalFs {
	files = new Map<string, VFile>()
	/** Names visible to readdir (the directory cache) and the names that survive a crash (the directory as last fsynced). */
	cacheNames = new Set<string>()
	durableNames = new Set<string>()
	private fds = new Map<number, { file: string; dir: boolean }>()
	private nextFd = 100
	syncs = { file: 0, dir: 0 }
	constructor(
		private readonly walDir: string,
		private readonly opts: { ignoreDirSync?: boolean; ignoreFileSync?: boolean } = {}
	) {}
	mkdirSync(): void {}
	openSync(p: string, flags: string): number {
		const fd = this.nextFd++
		if (flags === 'r') {
			this.fds.set(fd, { file: p, dir: true })
			return fd
		}
		const name = path.basename(p)
		if (!this.files.has(p)) {
			this.files.set(p, { durable: Buffer.alloc(0), cache: Buffer.alloc(0) })
			this.cacheNames.add(name)
		}
		this.fds.set(fd, { file: p, dir: false })
		return fd
	}
	writeSync(fd: number, buf: Buffer, offset: number, length: number): number {
		const f = this.files.get(this.fds.get(fd)!.file)!
		f.cache = Buffer.concat([f.cache, buf.subarray(offset, offset + length)])
		return length
	}
	fsyncSync(fd: number): void {
		const h = this.fds.get(fd)!
		if (h.dir) {
			this.syncs.dir++
			if (!this.opts.ignoreDirSync) this.durableNames = new Set(this.cacheNames)
			return
		}
		this.syncs.file++
		if (this.opts.ignoreFileSync) return
		const f = this.files.get(h.file)!
		f.durable = Buffer.from(f.cache)
	}
	closeSync(fd: number): void {
		this.fds.delete(fd)
	}
	fstatSync(fd: number): { size: number } {
		return { size: this.files.get(this.fds.get(fd)!.file)!.cache.length }
	}
	unlinkSync(p: string): void {
		this.files.delete(p)
		this.cacheNames.delete(path.basename(p))
	}
	readdirSync(): string[] {
		return [...this.cacheNames]
	}
	/** What a crash leaves on disk: only names that were directory-synced, with the fsynced bytes plus a random torn prefix or garbage of the unsynced tail. */
	crashImage(into: string, r: () => number, tail: 'none' | 'prefix' | 'garbage' | 'random'): void {
		const dir = path.join(into, WAL_DIR)
		fs.mkdirSync(dir, { recursive: true })
		for (const [p, f] of this.files) {
			const name = path.basename(p)
			if (!this.durableNames.has(name)) continue
			let content = f.durable
			const extra = f.cache.length > f.durable.length ? f.cache.subarray(f.durable.length) : Buffer.alloc(0)
			const mode = tail === 'random' ? (['none', 'prefix', 'garbage'] as const)[Math.floor(r() * 3)]! : tail
			if (extra.length > 0 && mode === 'prefix') content = Buffer.concat([content, extra.subarray(0, Math.floor(r() * (extra.length + 1)))])
			else if (extra.length > 0 && mode === 'garbage') {
				const g = Buffer.alloc(Math.floor(r() * extra.length) + 1)
				for (let i = 0; i < g.length; i++) g[i] = Math.floor(r() * 256)
				content = Buffer.concat([content, g])
			}
			fs.writeFileSync(path.join(dir, name), content)
		}
	}
}

const fatal = (e: Error): void => {
	throw e
}

/** One randomized run. Returns the problems found (empty = the claim holds). */
async function oneRun(seed: number, opts: { ignoreDirSync?: boolean; ignoreFileSync?: boolean }): Promise<string[]> {
	const r = rng(seed)
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labvol-'))
	const stateDir = path.join(root, 'state')
	const walDir = path.join(stateDir, WAL_DIR)
	const vfs = new VolatileFs(walDir, opts)
	const problems: string[] = []
	try {
		const evSeed = seed % 97
		const w = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 300 + Math.floor(r() * 700), fs: vfs, onFatal: fatal })
		let acked = 0
		const rounds = 4 + Math.floor(r() * 25)
		const crashAt = 1 + Math.floor(r() * (rounds - 1))
		for (let round = 0; round < rounds; round++) {
			const n = 1 + Math.floor(r() * 6)
			for (let i = 0; i < n; i++) {
				const seq = w.lastSeq + 1
				const { durable } = w.append('t', opsForSeq(evSeed, seq))
				void durable.then(() => {
					if (seq > acked) acked = seq
				})
			}
			if (round === crashAt) break // crash with whatever is queued, written or fsynced right now
			// let the writer run a random number of turns: sometimes the batch is flushed, sometimes not
			for (let t = 1 + Math.floor(r() * 3); t > 0; t--) await new Promise<void>((res) => setImmediate(res))
		}
		const ackedAtCrash = acked
		const image = path.join(root, 'image')
		vfs.crashImage(image, r, 'random')
		let lastSeq = 0
		const seen: number[] = []
		try {
			const res = scanWal(image, {
				afterSeq: 0,
				onEvent: (e) => {
					seen.push(e.seq)
					if (JSON.stringify(e.ops) !== JSON.stringify(opsForSeq(evSeed, e.seq))) problems.push(`seq ${e.seq}: ops differ from the event stream`)
				},
			})
			lastSeq = res.lastSeq
		} catch (e) {
			problems.push(`recovery scan threw: ${e instanceof Error ? e.message : String(e)}`)
			return problems
		}
		for (let i = 0; i < seen.length; i++) if (seen[i] !== i + 1) problems.push(`log is not a contiguous prefix at index ${i}: seq ${seen[i]}`)
		if (lastSeq < ackedAtCrash) problems.push(`ACKNOWLEDGED EVENT LOST: acked up to ${ackedAtCrash}, recovered only ${lastSeq}`)
		await w.close().catch(() => undefined)
		return problems
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
}

test('Z3 volatile page cache: over 400 randomized runs with a crash at a random moment, every acknowledged event survives and the recovered log is a contiguous prefix of the stream (rotated segments included)', async () => {
	const bad: string[] = []
	let ackedTotal = 0
	for (let seed = 1; seed <= 400; seed++) {
		const p = await oneRun(seed, {})
		if (p.length > 0) bad.push(`seed ${seed}: ${p.join('; ')}`)
		ackedTotal++
	}
	assert.deepEqual(bad, [])
	assert.equal(ackedTotal, 400)
})

test('Z3 sensitivity: with the directory fsync turned into a no-op the same harness reports lost acknowledged events (so a missing directory fsync would be caught)', async () => {
	let lost = 0
	for (let seed = 1; seed <= 300; seed++) {
		const p = await oneRun(seed, { ignoreDirSync: true })
		if (p.length > 0) lost++
	}
	assert.ok(lost > 20, `lost-event runs with the directory fsync disabled: ${lost}`)
})

test('Z3 sensitivity: with the file fsync turned into a no-op the same harness reports lost acknowledged events', async () => {
	let lost = 0
	for (let seed = 1; seed <= 300; seed++) {
		const p = await oneRun(seed, { ignoreFileSync: true })
		if (p.length > 0) lost++ // a lost ack or a log the recovery refuses: either way the harness flags it
	}
	assert.ok(lost > 20, `lost-event runs with the file fsync disabled: ${lost}`)
})

test('Z3 the writer syncs the file AND the directory of a new segment before the first event in it is acknowledged (counted on the double)', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labvol-'))
	try {
		const stateDir = path.join(root, 'state')
		const vfs = new VolatileFs(path.join(stateDir, WAL_DIR))
		const w = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: 200, fs: vfs, onFatal: fatal })
		const ps: Promise<void>[] = []
		for (let i = 0; i < 12; i++) ps.push(w.append('t', opsForSeq(1, w.lastSeq + 1)).durable)
		await Promise.all(ps)
		await w.close()
		const segments = vfs.cacheNames.size
		assert.ok(segments >= 3, `several segments (${segments})`)
		assert.ok(vfs.syncs.dir >= segments, `directory fsyncs ${vfs.syncs.dir} for ${segments} segments`)
		assert.deepEqual([...vfs.durableNames].sort(), [...vfs.cacheNames].sort(), 'every segment name is durable once the events are acknowledged')
		for (const [p, f] of vfs.files) assert.deepEqual(f.durable, f.cache, `${path.basename(p)} fully fsynced`)
	} finally {
		fs.rmSync(root, { recursive: true, force: true })
	}
})
