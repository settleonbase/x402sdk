export type ChatIndexPointerQueueEntry = {
	owner: string
	nonce: string
}

export function chatIndexPointerOwnerKey(owner: string): string {
	return owner.toLowerCase()
}

export function chatIndexPointerRequestKey(owner: string, nonce: string): string {
	return `${chatIndexPointerOwnerKey(owner)}:${nonce}`
}

/**
 * Select the first queued job whose owner is not currently in flight.
 * The caller removes the returned entry atomically before starting work.
 */
export function pickChatIndexPointerJobIndex(
	jobs: readonly ChatIndexPointerQueueEntry[],
	inFlightOwners: ReadonlySet<string>,
): number {
	for (let i = 0; i < jobs.length; i += 1) {
		if (!inFlightOwners.has(chatIndexPointerOwnerKey(jobs[i]!.owner))) return i
	}
	return -1
}
