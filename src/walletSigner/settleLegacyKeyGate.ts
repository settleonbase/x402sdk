import { chatWritesStopped } from './chatWriteStopGate'
import { walletSignerFeatureEnabled } from './remoteSigner'

export { chatWritesStopped, explicitChatRelayArray, legacyPoolMayResendChatNonce } from './chatWriteStopGate'

export function walletSignerFeatureList(): string[] {
	return (process.env.WALLET_SIGNER_FEATURES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Gray switch for the accepted low-privilege gas relay only.
 * Exact token `settleGasRelay`. `settle` and `all` do not turn this on:
 * those two replace the shared settle pool and close legacy-key businesses.
 */
export function settleGasRelayEnabled(): boolean {
	return walletSignerFeatureList().includes('settleGasRelay')
}

/** True only when the isolated relay may run without the broad settle switch. */
export function settleGasRelayIsolationActive(): boolean {
	return settleGasRelayEnabled() && !walletSignerFeatureEnabled('settle')
}

/**
 * Chat pointer route priority:
 * 1. WALLET_SIGNER_CHAT_WRITES=stopped — refuse the write; do not use the legacy pool
 * 2. `settle` or `all` — broad settle pool, isolation stays off
 * 3. `settleGasRelay` — isolated chat relay, even if `chat` is also set
 * 4. `chat` — explicit chat key array; the settle-admin default is refused
 * 5. otherwise — legacy settle pool
 *
 * Clearing WALLET_SIGNER_FEATURES is step 5, not a write stop.
 */
export type ChatRelayRoute = 'broad-settle' | 'isolated-chat-pointer' | 'chat-feature' | 'chat-writes-stopped' | 'legacy'

export function chatRelayRoute(): ChatRelayRoute {
	if (chatWritesStopped()) return 'chat-writes-stopped'
	if (walletSignerFeatureEnabled('settle')) return 'broad-settle'
	if (settleGasRelayEnabled()) return 'isolated-chat-pointer'
	if (walletSignerFeatureEnabled('chat')) return 'chat-feature'
	return 'legacy'
}

/**
 * Broad settle remote mode (`settle` or `all`). Not a gray-release switch:
 * it closes every direct legacy settle-key business and moves the shared pool.
 * Returns null when that mode is off, including when only `settleGasRelay` is set.
 */
export function settleLegacyPrivateKeyClosed(purpose: string): string | null {
	if (!walletSignerFeatureEnabled('settle')) return null
	return (
		`settle remote mode keeps ${purpose} closed and will not read legacy settle private keys; ` +
		'gas relay uses the signer pool, and admin signatures need a separate key array'
	)
}
