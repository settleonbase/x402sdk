/**
 * Flush-time guardian re-check. The guardian / beneficiary check at scan time can be weeks old by the time an entry reaches
 * the head of the pending queue. If a Lab pubkey has meanwhile gained a guardian with an active beneficiary, the redeem stack
 * settles that withdrawal, so paying it here as well would pay it twice. Before signing, the beneficiary is read again:
 *   beneficiary set       -> held: not signed this flush, stays pending, NOT marked consumed (once the other path settles it
 *                            on chain, the paid-key re-check drops it).
 *   read failed           -> unconfirmed: stays pending, not signed (same rule as an unreadable paid-key view).
 *   no beneficiary        -> kept for signing.
 * Residual gap: between this re-check and the transaction being mined the state can still change; closing it completely
 * needs the contract to record Lab payments as consumed on chain.
 */
import { ethers } from 'ethers'

export type GuardianPartition<T> = { keep: T[]; held: T[]; unconfirmed: T[] }

/** One read per distinct pubkey (cached), at most `concurrency` reads in flight; the order of every output list follows the input. */
export async function partitionByGuardianBeneficiary<T extends { pubkey: string }>(
	entries: T[],
	beneficiaryOf: (pubkeyHash: string) => Promise<string>,
	concurrency = 8
): Promise<GuardianPartition<T>> {
	const byPubkey = new Map<string, { ok: true; beneficiary: string } | { ok: false }>()
	const distinct = [...new Set(entries.map((e) => e.pubkey.toLowerCase()))]
	let next = 0
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(concurrency, distinct.length)) }, async () => {
			for (;;) {
				const i = next++
				if (i >= distinct.length) return
				const pk = distinct[i]!
				try {
					byPubkey.set(pk, { ok: true, beneficiary: await beneficiaryOf(ethers.keccak256(pk)) })
				} catch {
					byPubkey.set(pk, { ok: false })
				}
			}
		})
	)
	const out: GuardianPartition<T> = { keep: [], held: [], unconfirmed: [] }
	for (const e of entries) {
		const r = byPubkey.get(e.pubkey.toLowerCase())!
		if (!r.ok) out.unconfirmed.push(e)
		else if (r.beneficiary !== ethers.ZeroAddress) out.held.push(e)
		else out.keep.push(e)
	}
	return out
}
