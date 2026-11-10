/**
 * Unsettled chat tokens survive a process restart and still block the legacy pool.
 * This file does not import util.ts, settleContractPool.ts, chatIndexPointer.ts, or beamioMaster.ts.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	legacyPoolMayResendChatIdempotency,
	legacyPoolMayResendChatNonce,
	releaseRemoteChatToken,
	reloadChatRemoteTokenLedger,
	resetChatWriteStopForTests,
	retainRemoteChatToken,
	retainedRemoteChatToken,
} from './chatWriteStopGate.ts'

const here = dirname(fileURLToPath(import.meta.url))
const reviewRoot = dirname(dirname(here))
const gateUrl = pathToFileURL(join(here, 'chatWriteStopGate.ts')).href
const tsx = process.env.TSX ?? 'tsx'
const owner = '0x0000000000000000000000000000000000000001'
const dir = mkdtempSync(join(tmpdir(), 'chat-token-ledger-'))
const ledger = join(dir, 'ledger.json')
const prevLedger = process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER

function chatKey(nonce: string): string {
	return `chat:${owner}:${nonce}`
}

function useLedger(): void {
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = ledger
	resetChatWriteStopForTests()
}

function freshProcess(nonce: string, key: string): { nonceOk: boolean; keyOk: boolean } {
	const script = [
		`import { legacyPoolMayResendChatNonce, legacyPoolMayResendChatIdempotency } from ${JSON.stringify(gateUrl)}`,
		'const nonceOk = legacyPoolMayResendChatNonce(process.env.CHECK_OWNER, process.env.CHECK_NONCE)',
		'const keyOk = legacyPoolMayResendChatIdempotency(process.env.CHECK_KEY)',
		'process.stdout.write(JSON.stringify({ nonceOk, keyOk }))',
	].join('\n')
	const child = spawnSync(tsx, ['--eval', script], {
		cwd: reviewRoot,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			WALLET_SIGNER_CHAT_TOKEN_LEDGER: ledger,
			CHECK_OWNER: owner,
			CHECK_NONCE: nonce,
			CHECK_KEY: key,
		},
		encoding: 'utf8',
	})
	assert.equal(child.status, 0, child.stderr || child.stdout)
	return JSON.parse(child.stdout) as { nonceOk: boolean; keyOk: boolean }
}

test('unconfirmed token still blocks the legacy pool after restart', () => {
	useLedger()
	retainRemoteChatToken({
		idempotencyKey: chatKey('7'),
		owner,
		pointerNonce: '7',
		phase: 'unconfirmed',
	})
	assert.equal(legacyPoolMayResendChatNonce(owner, '7'), false)
	reloadChatRemoteTokenLedger()
	assert.equal(retainedRemoteChatToken(chatKey('7'))?.phase, 'unconfirmed')
	assert.equal(legacyPoolMayResendChatNonce(owner, '7'), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('7')), false)
	const restarted = freshProcess('7', chatKey('7'))
	assert.equal(restarted.nonceOk, false)
	assert.equal(restarted.keyOk, false)
})

test('confirmed receipt releases the token across restart', () => {
	useLedger()
	retainRemoteChatToken({
		idempotencyKey: chatKey('9'),
		owner,
		pointerNonce: '9',
		phase: 'unconfirmed',
	})
	releaseRemoteChatToken(chatKey('9'))
	const body = JSON.parse(readFileSync(ledger, 'utf8')) as { v: number; tokens: unknown[] }
	assert.equal(body.v, 1)
	assert.equal(body.tokens.length, 0)
	reloadChatRemoteTokenLedger()
	assert.equal(retainedRemoteChatToken(chatKey('9')), undefined)
	assert.equal(legacyPoolMayResendChatNonce(owner, '9'), true)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('9')), true)
	const restarted = freshProcess('9', chatKey('9'))
	assert.equal(restarted.nonceOk, true)
	assert.equal(restarted.keyOk, true)
})

test('abandoned token still blocks the legacy pool after restart', () => {
	useLedger()
	retainRemoteChatToken({
		idempotencyKey: chatKey('8'),
		owner,
		pointerNonce: '8',
		phase: 'abandoned',
	})
	reloadChatRemoteTokenLedger()
	assert.equal(retainedRemoteChatToken(chatKey('8'))?.phase, 'abandoned')
	assert.equal(legacyPoolMayResendChatNonce(owner, '8'), false)
	const restarted = freshProcess('8', chatKey('8'))
	assert.equal(restarted.nonceOk, false)
	assert.equal(restarted.keyOk, false)
})

test('missing, empty, and old ledgers do not crash or look settled', () => {
	useLedger()
	rmSync(ledger)
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '1'), true)
	assert.equal(freshProcess('1', chatKey('1')).nonceOk, true)

	writeFileSync(ledger, '')
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '1'), true)
	assert.equal(freshProcess('1', chatKey('1')).nonceOk, true)

	writeFileSync(ledger, JSON.stringify([
		{ owner, pointerNonce: '4', phase: 'confirmed', status: 'settled', receiptStatus: 1 },
		{ idempotencyKey: chatKey('5') },
	]))
	reloadChatRemoteTokenLedger()
	assert.equal(retainedRemoteChatToken(chatKey('4'))?.phase, 'unconfirmed')
	assert.equal(legacyPoolMayResendChatNonce(owner, '4'), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('5')), false)
	const oldRestart = freshProcess('4', chatKey('5'))
	assert.equal(oldRestart.nonceOk, false)
	assert.equal(oldRestart.keyOk, false)

	writeFileSync(ledger, `${JSON.stringify({ owner, nonce: 6, settlement: 'mined' })}\n`)
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '6'), false)
	assert.equal(freshProcess('6', chatKey('6')).nonceOk, false)

	writeFileSync(ledger, '{{{not-json')
	reloadChatRemoteTokenLedger()
	assert.equal(legacyPoolMayResendChatNonce(owner, '99'), false)
	assert.equal(legacyPoolMayResendChatIdempotency(chatKey('99')), false)
	assert.equal(freshProcess('99', chatKey('99')).nonceOk, false)
})

test('cleanup ledger env', () => {
	process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = ledger
	resetChatWriteStopForTests()
	if (prevLedger === undefined) delete process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER
	else process.env.WALLET_SIGNER_CHAT_TOKEN_LEDGER = prevLedger
	reloadChatRemoteTokenLedger()
	rmSync(dir, { recursive: true, force: true })
	assert.equal(true, true)
})
