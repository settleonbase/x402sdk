/**
 * Test support for labWal.test.ts (real process kill -9): appends deterministic events to a WAL as fast as it can, and prints "durable <seq>"
 * only after the fsync that made the event durable. The parent kills it with SIGKILL at a random moment and then recovers the log.
 * Usage: node --import tsx labWalKillChild.ts <stateDir> <seed> <segmentBytes>
 */
import { WalWriter, type WalOp } from './labWal'

export function opsForSeq(seed: number, seq: number): WalOp[] {
	let s = (Math.imul(seed ^ 0x9e3779b9, 1664525) + Math.imul(seq, 1013904223)) >>> 0
	const next = (): number => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		return s / 0x100000000
	}
	const key = (i: number): string => `0x${i.toString(16).padStart(64, '0')}`
	const ops: WalOp[] = []
	const n = 1 + Math.floor(next() * 3)
	for (let i = 0; i < n; i++) {
		const k = key(Math.floor(next() * 60))
		const x = next()
		if (x < 0.35) ops.push({ op: 'pendingAdd', entry: { eventKey: k, blockNumber: Math.floor(next() * 1000) } })
		else if (x < 0.55) ops.push({ op: 'pendingDel', key: k })
		else if (x < 0.8) ops.push({ op: 'consumedAdd', key: k })
		else ops.push({ op: 'scalarsSet', patch: { historyCursor: Math.floor(next() * 100000), note: `n${seq}` } })
	}
	return ops
}

async function main(): Promise<void> {
	const [stateDir, seedRaw, segRaw] = process.argv.slice(2)
	if (!stateDir) throw new Error('usage: labWalKillChild <stateDir> <seed> <segmentBytes>')
	const seed = Number(seedRaw ?? 1)
	const w = new WalWriter({ stateDir, lastSeq: 0, segmentBytes: Number(segRaw ?? 4096) })
	for (;;) {
		// a few events per turn so that group commit is exercised too
		const batch = []
		for (let i = 0; i < 3; i++) {
			const seq = w.lastSeq + 1
			batch.push(w.append('t', opsForSeq(seed, seq)))
		}
		await Promise.all(batch.map((b) => b.durable))
		process.stdout.write(`durable ${batch[batch.length - 1]!.seq}\n`)
	}
}

if (require.main === module) {
	main().catch((e) => {
		process.stderr.write(`child error: ${e instanceof Error ? e.message : String(e)}\n`)
		process.exit(1)
	})
}
