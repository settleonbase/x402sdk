import type { RemoteSigner } from './remoteSigner'

/**
 * Idle signers for the isolated chat-pointer gas relay.
 * Kept out of settleContractPool so the send path does not load master.json.
 */
let idle: RemoteSigner[] = []
/** Checked-out signers whose chain signature is not a confirmed settlement. */
let held: RemoteSigner[] = []

export function isolatedChatRelayIdleCount(): number {
	return idle.length
}

export function isolatedChatRelayHeldCount(): number {
	return held.length
}

export function takeIsolatedChatRelay(): RemoteSigner | undefined {
	return idle.shift()
}

export function releaseIsolatedChatRelay(signer: RemoteSigner): void {
	const heldAt = held.indexOf(signer)
	if (heldAt >= 0) held.splice(heldAt, 1)
	if (!idle.includes(signer)) idle.push(signer)
}

/** Keep the signer out of the idle pool until a later confirmed release. */
export function holdIsolatedChatRelay(signer: RemoteSigner): void {
	if (!held.includes(signer)) held.push(signer)
}

/** Replace the idle list. Production init and local acceptance both use this. */
export function setIsolatedChatRelayIdle(signers: readonly RemoteSigner[]): void {
	idle = [...signers]
	held = []
}

export function resetIsolatedChatRelayForTests(): void {
	idle = []
	held = []
}
