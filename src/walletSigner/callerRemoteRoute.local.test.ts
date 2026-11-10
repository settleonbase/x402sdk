/**
 * Call-site contract for the remote signer wires that were still only in the
 * dirty x402sdk worktree. Importing chatIndexPointer, settleContractPool, or
 * beamioMaster would read master.json, so this checks the wired call text.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function source(rel: string): string {
	return readFileSync(join(here, rel), 'utf8')
}

function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start)
	assert.notEqual(from, -1, `missing ${start}`)
	const to = text.indexOf(end, from + start.length)
	assert.notEqual(to, -1, `missing ${end} after ${start}`)
	return text.slice(from, to)
}

test('master setChatIndexPointer sends through the isolated remote handler', () => {
	const master = source('../endpoint/beamioMaster.ts')
	assert.match(master, /import \{ writeIsolatedChatPointerResponse \} from '\.\.\/walletSigner\/chatPointerHttpRoute'/)
	assert.match(master, /import \{ chatWritesStopped, settleGasRelayIsolationActive \} from '\.\.\/walletSigner\/settleLegacyKeyGate'/)
	const handler = between(master, "router.post('/setChatIndexPointer'", "router.post('/agentReferrerRegister'")
	const stopped = handler.indexOf('chatWritesStopped()')
	const isolated = handler.indexOf('settleGasRelayIsolationActive()')
	const send = handler.indexOf('writeIsolatedChatPointerResponse(b, res)')
	const legacy = handler.indexOf('enqueueChatIndexPointerRelay(')
	assert.ok(stopped >= 0 && isolated > stopped && send > isolated && legacy > send)
	assert.match(handler.slice(stopped, isolated), /legacyFallback: false/)
	assert.equal(handler.slice(isolated, send).includes('settleLegacyPrivateKeyClosed'), false)
})

test('chat pointer relay takes an isolated remote signer and a nonce idempotency key', () => {
	const relay = source('../chatIndexPointer.ts')
	const take = between(relay, 'function takeRelaySlot()', 'function releaseRelaySlot')
	assert.match(take, /route === 'chat-writes-stopped'/)
	assert.match(take, /route === 'isolated-chat-pointer'/)
	assert.match(take, /takeIsolatedSettleGasRelay\(\)/)
	assert.match(take, /kind: 'isolated'/)
	assert.match(take, /conetSignerPool\(oldPool\)\.acquire\(\)/)
	assert.match(take, /explicitChatRelayArray\(\)/)
	assert.match(take, /conetSignerPool\(array\)\.acquire\(\)/)
	assert.equal(take.includes('CHAT_RELAY_KEY_ARRAY'), false)
	assert.ok(take.indexOf('chat-writes-stopped') < take.indexOf('shiftSettleConet()'))
	const release = between(relay, 'function releaseRelaySlot', 'const CHAT_INDEX_REGISTRY_ABI')
	assert.match(release, /releaseIsolatedSettleGasRelay\(slot\.signer\)/)
	const job = between(relay, 'async function relayChatIndexPointerJob', 'export { submitIsolatedChatPointer }')
	assert.match(job, /chatPointerIdempotencyKey\(job\.owner, job\.nonce\)/)
	assert.match(job, /chatPointerRegistryAddress\(\)/)
	assert.equal(job.includes('chat:${job.requestKey}'), false)
	assert.match(relay, /export \{ submitIsolatedChatPointer \} from '\.\/walletSigner\/chatPointerIsolatedSend'/)
})

test('settle roster and isolated gas relay refuse a legacy private-key read', () => {
	const pool = source('../settleContractPool.ts')
	const remote = between(pool, 'function initFromWalletSigner()', 'function initIsolatedGasRelay()')
	assert.match(remote, /WalletSignerClient\.fromEnv\(\)/)
	assert.match(remote, /loadSettleRelayRoster\(/)
	assert.match(remote, /new RemoteSigner\(/)
	assert.match(remote, /settle remote gas relay refused a legacy private-key read/)
	assert.match(remote, /if \(row\.base\) Settle_BasePool\.push\(entry\)/)
	const isolated = between(pool, 'function initIsolatedGasRelay()', 'export function settleContractPoolReady()')
	assert.match(isolated, /resolveChatPointerRelayConfig\(\)/)
	assert.match(isolated, /WalletSignerClient\.fromEnv\(\)/)
	assert.match(isolated, /runLowPrivGasRelayAttempt\(/)
	assert.match(isolated, /isolated settle gas relay refused a legacy private-key read/)
	assert.match(isolated, /setIsolatedChatRelayIdle\(signers\)/)
	const init = between(pool, 'export function initSettleContractPool()', 'export function ensureSettleContractPoolInitialized()')
	assert.match(init, /if \(walletSignerFeatureEnabled\('settle'\)\)/)
	assert.match(init, /if \(settleGasRelayIsolationActive\(\)\) void initIsolatedGasRelay\(\)/)
	assert.match(init, /if \(settleGasRelayIsolationActive\(\)\) \{\s*void initIsolatedGasRelay\(\)/)
})
