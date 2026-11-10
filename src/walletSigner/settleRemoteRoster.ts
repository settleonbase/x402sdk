export type SettleRemoteKeyPlacement = {
	address: string
	/** Present on the CoNET authorization list. */
	conet: boolean
	/** Present on the Base authorization list. Unlisted keys must not take a Base schedule slot. */
	base: boolean
}

/**
 * Build the settle roster from the CoNET grant, then mark Base only when that
 * chain's account list includes the same key. Comparison is case-insensitive.
 * A Base-only address is not added: the roster source is the CoNET grant.
 */
export function placeSettleRemoteKeys(
	conetAddresses: readonly string[],
	baseAddresses: readonly string[],
): SettleRemoteKeyPlacement[] {
	const base = new Set(baseAddresses.map((a) => a.toLowerCase()))
	const seen = new Set<string>()
	const out: SettleRemoteKeyPlacement[] = []
	for (const address of conetAddresses) {
		const lc = address.toLowerCase()
		if (seen.has(lc)) continue
		seen.add(lc)
		out.push({ address, conet: true, base: base.has(lc) })
	}
	return out
}
