/**
 * The money rules of the Lab wallet pools, as pure functions (no I/O, node built-ins only) so each rule can be tested directly and a mutation of one is caught without relying on scheduling.
 *   - parseReserveWei:  the VDR balance the pool never touches. Required (no default), `0` is valid, ONLY a plain non-negative decimal integer is accepted.
 *   - poolAvailableWei: what one wallet may spend = balance - reserve - the amount committed in wallet slots - the amount other wallets have claimed (and not yet booked). Never negative.
 *   - readBalanceStrict: a failed balance read is an error, never a number. The caller makes no claim and sends nothing.
 */
export const RESERVE_ENV = 'CONET_LAB_MINING_POOL_CL_PAYOUT_MIN_VDR_BALANCE_RESERVE_WEI'

export function parseReserveWei(rawIn: string | undefined): bigint {
	const raw = rawIn?.trim()
	if (raw === undefined || raw === '') throw new Error(`[labMiningPoolClPayout] pool mode needs ${RESERVE_ENV} (no default)`)
	if (!/^\d+$/.test(raw)) throw new Error(`[labMiningPoolClPayout] ${RESERVE_ENV} must be a non-negative integer in wei (digits only, 0 is valid); got "${raw.slice(0, 40)}"`)
	return BigInt(raw)
}

export function poolAvailableWei(balance: bigint, reserve: bigint, committedSlotsWei: bigint, otherClaimsWei: bigint): bigint {
	const held = reserve + committedSlotsWei + otherClaimsWei
	return balance > held ? balance - held : 0n
}

export async function readBalanceStrict(read: () => Promise<bigint>): Promise<bigint> {
	const v = await read()
	if (typeof v !== 'bigint' || v < 0n) throw new Error('balance read did not return a non-negative bigint')
	return v
}

/** A batch is paid when its total does not exceed what the wallet may spend: exactly equal is allowed. */
export const batchFits = (totalWei: bigint, availableWei: bigint): boolean => totalWei <= availableWei
