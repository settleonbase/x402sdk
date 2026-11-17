import { wordlist } from '@scure/bip39/wordlists/english'

const WORDS = new Set(wordlist)
const HEX64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g

/**
 * Best-effort scrub for free text (error messages, log lines). Tx hashes are 64 hex too, so this
 * is only applied to text, never to structured fields such as `txHash`.
 */
export function redactText(input: string): string {
	let out = input.replace(HEX64, '[hex64]')
	// Runs of 12+ BIP-39 words look like a mnemonic.
	const tokens = out.split(/(\s+)/)
	let run: number[] = []
	const flush = () => {
		if (run.length >= 12) for (const i of run) tokens[i] = '[word]'
		run = []
	}
	tokens.forEach((t, i) => {
		if (/^\s+$/.test(t)) return
		if (WORDS.has(t.toLowerCase())) run.push(i)
		else flush()
	})
	flush()
	out = tokens.join('')
	return out.length > 2000 ? `${out.slice(0, 2000)}…` : out
}

export function errorMessage(e: unknown): string {
	const err = e as { shortMessage?: string; reason?: string; message?: string }
	return redactText(err?.shortMessage ?? err?.reason ?? err?.message ?? String(e))
}
