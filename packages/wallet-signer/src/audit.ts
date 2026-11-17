import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { canonicalHash } from './canonical'

/**
 * Hash-chained JSONL. Each line carries `prevLineHash` and its own `lineHash` (names chosen so
 * they never collide with event fields such as a tx `hash`), so deleting or editing a line breaks
 * the chain. Never pass passwords, mnemonics or keys in here.
 * Ship the file off-host (journald/rsyslog) — see deploy notes.
 */
export class AuditLog {
	private prev = '0x'
	private seq = 0

	constructor(private readonly path: string) {
		if (existsSync(path)) {
			const lines = readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean)
			const last = lines.at(-1)
			if (last) {
				const parsed = JSON.parse(last) as { lineHash: string; seq: number }
				this.prev = parsed.lineHash
				this.seq = parsed.seq
			}
		}
	}

	write(event: Record<string, unknown>): void {
		const { ts: _t, seq: _s, prevLineHash: _p, lineHash: _l, ...rest } = event
		const line: Record<string, unknown> = { ts: new Date().toISOString(), seq: ++this.seq, prevLineHash: this.prev, ...rest }
		const lineHash = canonicalHash(line)
		appendFileSync(this.path, `${JSON.stringify({ ...line, lineHash }, bigintReplacer)}\n`, { mode: 0o640 })
		this.prev = lineHash
	}
}

/** Verifies the chain; returns the first broken seq or null. */
export function verifyAuditFile(path: string): number | null {
	let prev = '0x'
	for (const raw of readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean)) {
		const { lineHash, ...line } = JSON.parse(raw) as Record<string, unknown> & { lineHash: string; seq: number; prevLineHash: string }
		if (line.prevLineHash !== prev || canonicalHash(line) !== lineHash) return line.seq
		prev = lineHash
	}
	return null
}

export function bigintReplacer(_k: string, v: unknown): unknown {
	return typeof v === 'bigint' ? v.toString() : v
}
