/**
 * On-chain paid-key read used before any CL payout is signed.
 * Unknown is not payable. The caller keeps those rows pending and retries the read.
 */

export type PaidKeyPartition<T> = {
	payable: T[]
	alreadyPaid: T[]
	unconfirmed: T[]
	errors: { eventKey: string; message: string }[]
}

export class PaidKeyViewUnconfirmed extends Error {
	readonly eventKey: string
	constructor(eventKey: string, message: string) {
		super(message)
		this.name = 'PaidKeyViewUnconfirmed'
		this.eventKey = eventKey
	}
}

export async function partitionByPaidKey<T extends { eventKey: string }>(
	entries: T[],
	readConsumed: (eventKey: string) => Promise<boolean>
): Promise<PaidKeyPartition<T>> {
	const payable: T[] = []
	const alreadyPaid: T[] = []
	const unconfirmed: T[] = []
	const errors: { eventKey: string; message: string }[] = []
	for (const entry of entries) {
		try {
			const consumed = await readConsumed(entry.eventKey)
			if (consumed) alreadyPaid.push(entry)
			else payable.push(entry)
		} catch (err: unknown) {
			unconfirmed.push(entry)
			errors.push({
				eventKey: entry.eventKey,
				message: err instanceof Error ? err.message : String(err),
			})
		}
	}
	return { payable, alreadyPaid, unconfirmed, errors }
}

/** Last confirmed block stays put when this block's paid-key view failed. */
export function cursorIfBlockConfirmed(
	previousOk: number | null,
	block: number,
	viewConfirmed: boolean
): number | null {
	if (!viewConfirmed) return previousOk
	return block
}
