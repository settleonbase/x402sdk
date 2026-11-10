import { placeSettleRemoteKeys, type SettleRemoteKeyPlacement } from './settleRemoteRoster'

/** Minimal signer lookup used by the settle gas relay. No private keys. */
export type SettleRelayLookup = {
	accounts(keyArray: string, chainId: number): Promise<string[]>
}

export type SettleRelayRosterResult =
	| {
			ok: true
			mode: 'remote'
			placed: SettleRemoteKeyPlacement[]
			legacyKeyReads: 0
	  }
	| {
			ok: true
			mode: 'legacy'
			keyCount: number
	  }
	| {
			ok: false
			mode: 'remote'
			code: 'signer_unavailable' | 'no_remote_keys'
			error: string
			legacyKeyReads: 0
	  }

/**
 * One attempt to load the settle gas-relay roster.
 * Remote mode never calls `readLegacyKeys`, including when the signer is down or returns no keys.
 */
export async function loadSettleRelayRoster(input: {
	remote: boolean
	keyArray: string
	conetChainId: number
	baseChainId: number
	lookup: SettleRelayLookup
	readLegacyKeys: () => readonly string[]
}): Promise<SettleRelayRosterResult> {
	if (!input.remote) {
		const keys = input.readLegacyKeys()
		return { ok: true, mode: 'legacy', keyCount: keys.length }
	}
	let conet: string[]
	try {
		conet = await input.lookup.accounts(input.keyArray, input.conetChainId)
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e)
		return {
			ok: false,
			mode: 'remote',
			code: 'signer_unavailable',
			error: `wallet-signer unavailable for settle gas relay: ${detail}`,
			legacyKeyReads: 0,
		}
	}
	let base: string[] = []
	try {
		base = await input.lookup.accounts(input.keyArray, input.baseChainId)
	} catch {
		base = []
	}
	const placed = placeSettleRemoteKeys(conet, base)
	if (placed.length === 0) {
		return {
			ok: false,
			mode: 'remote',
			code: 'no_remote_keys',
			error: `wallet-signer: no keys in ${input.keyArray}`,
			legacyKeyReads: 0,
		}
	}
	return { ok: true, mode: 'remote', placed, legacyKeyReads: 0 }
}

export type LowPrivRelayState = {
	placed: SettleRemoteKeyPlacement[]
}

export type LowPrivRelayAttempt =
	| { ok: false; code: 'isolation_off' }
	| { ok: false; code: 'signer_unavailable' | 'no_remote_keys'; error: string; legacyKeyReads: 0 }
	| { ok: true; code: 'ready'; placed: SettleRemoteKeyPlacement[]; legacyKeyReads: 0 }

/**
 * Business attempt used by the isolated gas relay. Isolation off does not call
 * the signer and does not read legacy keys. Failure leaves `state` unchanged.
 * Success replaces `state.placed` and is the recovery path.
 */
export async function runLowPrivGasRelayAttempt(input: {
	isolationEnabled: boolean
	keyArray: string
	conetChainId: number
	baseChainId: number
	lookup: SettleRelayLookup
	readLegacyKeys: () => readonly string[]
	state: LowPrivRelayState
}): Promise<LowPrivRelayAttempt> {
	if (!input.isolationEnabled) return { ok: false, code: 'isolation_off' }
	const roster = await loadSettleRelayRoster({
		remote: true,
		keyArray: input.keyArray,
		conetChainId: input.conetChainId,
		baseChainId: input.baseChainId,
		lookup: input.lookup,
		readLegacyKeys: input.readLegacyKeys,
	})
	if (!roster.ok) {
		return { ok: false, code: roster.code, error: roster.error, legacyKeyReads: 0 }
	}
	if (roster.mode !== 'remote') {
		return {
			ok: false,
			code: 'signer_unavailable',
			error: 'isolated settle gas relay refused legacy mode',
			legacyKeyReads: 0,
		}
	}
	input.state.placed = roster.placed
	return { ok: true, code: 'ready', placed: roster.placed, legacyKeyReads: 0 }
}

export type LowPrivRelayChoice =
	| { use: 'legacy' }
	| { use: 'remote'; address: string }
	| { use: 'unavailable' }

/**
 * Slot choice for the low-privilege relay. While isolation is on, an idle legacy
 * pool is not a fallback: the attempt stays unavailable until a remote CoNET key exists.
 */
export function chooseLowPrivRelaySlot(input: {
	isolationEnabled: boolean
	remoteConetAddresses: readonly string[]
	legacyIdle: boolean
}): LowPrivRelayChoice {
	if (!input.isolationEnabled) {
		return input.legacyIdle ? { use: 'legacy' } : { use: 'unavailable' }
	}
	const address = input.remoteConetAddresses.find((item) => item.trim().length > 0)
	if (!address) return { use: 'unavailable' }
	return { use: 'remote', address }
}
