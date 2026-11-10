/**
 * Isolated chat send takes a signer before the ledger write.
 * No signer means no ledger row. A failed write returns the signer and does not send.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Interface } from 'ethers'
import { CHAT_POINTER_METHOD } from './chatPointerRelayGate.ts'
import { submitIsolatedChatPointer } from './chatPointerIsolatedSend.ts'
import {
	legacyPoolMayResendChatNonce,
	reloadChatRemoteTokenLedger,
	resetChatWriteStopForTests,
} from './chatWriteStopGate.ts'
import {
	isolatedChatRelayIdleCount,
	resetIsolatedChatRelayForTests,
	setIsolatedChatRelayIdle,
} from './isolatedChatRelayPool.ts'
import { RemoteSigner, WalletSignerClient } from './remoteSigner.ts'

const owner = '0x0000000000000000000000000000000000000001'
const pointerIface = new Interface([`function ${CHAT_POINTER_METHOD}`])
const prevLedger = process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
const root = mkdtempSync(join(tmpdir(), 'chat-signer-before-ledger-'))
const ledger = join(root, 'ledger.json')

function calldata(nonce: bigint): string {
	return pointerIface.encodeFunctionData('setPointerWithSig', [
		owner,
		`0x${'11'.repeat(32)}`,
		1n,
		1n,
		nonce,
		`0x${'ab'.repeat(65)}`,
	])
}

test('no signer does not write the ledger and a failed persist returns the signer', async () => {
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = ledger
	resetChatWriteStopForTests()
	resetIsolatedChatRelayForTests()
	let sends = 0
	const original = RemoteSigner.prototype.sendTransaction
	RemoteSigner.prototype.sendTransaction = async () => {
		sends += 1
		return { hash: `0x${'ab'.repeat(32)}`, wait: async () => ({ status: 1 }) } as never
	}
	const signer = new RemoteSigner(new WalletSignerClient({ url: 'unix:/tmp/wallet-signer-signer-order.sock' }), {
		keyArray: 'chat_index_pointer',
		chainId: 224422,
		address: owner,
	})
	try {
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: calldata(41n),
			value: 0n,
			gasLimit: 150_000n,
		}), /signer_unavailable/)
		assert.equal(sends, 0)
		assert.equal(readFileSync(ledger, 'utf8').includes(':41'), false)
		reloadChatRemoteTokenLedger()
		assert.equal(legacyPoolMayResendChatNonce(owner, '41'), true)

		setIsolatedChatRelayIdle([signer])
		chmodSync(root, 0o555)
		await assert.rejects(submitIsolatedChatPointer({
			to: owner,
			data: calldata(42n),
			value: 0n,
			gasLimit: 150_000n,
		}), /chat_token_ledger_persist_failed/)
		chmodSync(root, 0o700)
		assert.equal(sends, 0)
		assert.equal(isolatedChatRelayIdleCount(), 1)
		assert.equal(readFileSync(ledger, 'utf8').includes(':42'), false)
		reloadChatRemoteTokenLedger()
		assert.equal(legacyPoolMayResendChatNonce(owner, '42'), true)
	} finally {
		RemoteSigner.prototype.sendTransaction = original
		chmodSync(root, 0o700)
		resetIsolatedChatRelayForTests()
		if (prevLedger === undefined) delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
		else process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = prevLedger
		resetChatWriteStopForTests()
	}
})
