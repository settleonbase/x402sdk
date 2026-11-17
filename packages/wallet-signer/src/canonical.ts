import { keccak256, toUtf8Bytes } from 'ethers'

/** Stable JSON: object keys sorted, no whitespace. Used for registry / policy hashes. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString()
	if (Array.isArray(value)) return value.map(sortDeep)
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[k]
			if (v !== undefined) out[k] = sortDeep(v)
		}
		return out
	}
	return value
}

export function canonicalHash(value: unknown): string {
	return keccak256(toUtf8Bytes(canonicalJson(value)))
}
